"""Private process host. A Job Object is lifetime control, not a filesystem sandbox."""
import base64
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import threading
import time

LOCK = threading.Lock()
DISCONNECTED = threading.Event()


def emit(value):
    try:
        with LOCK:
            sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    except (BrokenPipeError, OSError):
        DISCONNECTED.set()


def checked_request():
    line = sys.stdin.buffer.readline(524289)
    if len(line) > 524288 or not line.endswith(b"\n"):
        raise ValueError("BAD_REQUEST")
    value = json.loads(line)
    if not isinstance(value, dict) or set(value) != {"command", "args", "cwd", "env", "input", "pins", "timeout_ms"}:
        raise ValueError("BAD_REQUEST")
    if not isinstance(value["command"], str) or not os.path.isabs(value["command"]) or not os.path.isfile(value["command"]):
        raise ValueError("BAD_COMMAND")
    if os.name == "nt" and not value["command"].lower().endswith(".exe"):
        raise ValueError("NATIVE_COMMAND_REQUIRED")
    if not isinstance(value["cwd"], str) or not os.path.isabs(value["cwd"]) or not os.path.isdir(value["cwd"]):
        raise ValueError("BAD_CWD")
    if not isinstance(value["args"], list) or len(value["args"]) > 200 or any(not isinstance(x, str) or "\0" in x for x in value["args"]):
        raise ValueError("BAD_ARGS")
    if not isinstance(value["env"], dict) or any(not isinstance(k, str) or not k or "=" in k or "\0" in k or not isinstance(v, str) or "\0" in v for k, v in value["env"].items()):
        raise ValueError("BAD_ENV")
    if not isinstance(value["input"], str) or len(value["input"].encode("utf-8")) > 131072:
        raise ValueError("BAD_INPUT")
    if type(value["timeout_ms"]) is not int or not 50 <= value["timeout_ms"] <= 86400000:
        raise ValueError("BAD_TIMEOUT")
    pins = value["pins"]
    if not isinstance(pins, list) or not 1 <= len(pins) <= 16:
        raise ValueError("BAD_PINS")
    paths = set()
    for pin in pins:
        if not isinstance(pin, dict) or set(pin) != {"path", "sha256"} or not isinstance(pin["path"], str) or not os.path.isabs(pin["path"]):
            raise ValueError("BAD_PINS")
        with open(pin["path"], "rb") as handle:
            observed = hashlib.file_digest(handle, "sha256").hexdigest()
        if pin["sha256"] != observed:
            raise ValueError("PIN_CHANGED")
        paths.add(os.path.normcase(os.path.realpath(pin["path"])))
    if os.path.normcase(os.path.realpath(value["command"])) not in paths:
        raise ValueError("COMMAND_NOT_PINNED")
    return value


class WindowsProcess:
    containment = "windows-job"

    def __init__(self, request):
        import msvcrt
        from ctypes import wintypes as w
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k = k
        size = ctypes.c_size_t
        class BasicLimits(ctypes.Structure):
            _fields_ = [("ProcessTime", ctypes.c_longlong), ("JobTime", ctypes.c_longlong),
                        ("Flags", w.DWORD), ("MinWorkingSet", size), ("MaxWorkingSet", size),
                        ("ActiveLimit", w.DWORD), ("Affinity", size), ("Priority", w.DWORD), ("Scheduling", w.DWORD)]
        class IOCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ["ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes"]]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("Basic", BasicLimits), ("IO", IOCounters), ("ProcessMemory", size), ("JobMemory", size), ("PeakProcess", size), ("PeakJob", size)]
        class Accounting(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in ["User", "Kernel", "PeriodUser", "PeriodKernel"]] + [
                ("PageFaults", w.DWORD), ("Total", w.DWORD), ("Active", w.DWORD), ("Terminated", w.DWORD)]
        class Startup(ctypes.Structure):
            _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR), ("title", w.LPWSTR),
                        ("x", w.DWORD), ("y", w.DWORD), ("xSize", w.DWORD), ("ySize", w.DWORD), ("xChars", w.DWORD),
                        ("yChars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD), ("show", w.WORD),
                        ("reservedSize", w.WORD), ("reserved2", ctypes.c_void_p),
                        ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE)]
        class StartupEx(ctypes.Structure):
            _fields_ = [("base", Startup), ("attributes", ctypes.c_void_p)]
        class ProcessInfo(ctypes.Structure):
            _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
            "SetInformationJobObject": ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD], w.BOOL),
            "QueryInformationJobObject": ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p], w.BOOL),
            "AssignProcessToJobObject": ([w.HANDLE, w.HANDLE], w.BOOL),
            "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
            "TerminateProcess": ([w.HANDLE, w.UINT], w.BOOL),
            "ResumeThread": ([w.HANDLE], w.DWORD),
            "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
            "GetExitCodeProcess": ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
            "CloseHandle": ([w.HANDLE], w.BOOL),
            "InitializeProcThreadAttributeList": ([ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(size)], w.BOOL),
            "UpdateProcThreadAttribute": ([ctypes.c_void_p, w.DWORD, size, ctypes.c_void_p, size, ctypes.c_void_p, ctypes.c_void_p], w.BOOL),
            "DeleteProcThreadAttributeList": ([ctypes.c_void_p], None),
            "CreateProcessW": ([w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD,
                                ctypes.c_void_p, w.LPCWSTR, ctypes.POINTER(StartupEx), ctypes.POINTER(ProcessInfo)], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(k, name)
            fn.argtypes, fn.restype = args, result
        self.Accounting, self.DWORD = Accounting, w.DWORD
        self.job, self.process, self.thread = None, None, None
        fds = []
        attributes = None
        try:
            self.job = k.CreateJobObjectW(None, None)
            if not self.job:
                raise OSError("JOB_CREATE_FAILED")
            limits = ExtendedLimits()
            limits.Basic.Flags = 0x2000  # KILL_ON_JOB_CLOSE; never allow breakaway.
            if not k.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise OSError("JOB_CONFIG_FAILED")
            read_in, write_in = os.pipe()
            read_out, write_out = os.pipe()
            read_err, write_err = os.pipe()
            fds = [read_in, write_in, read_out, write_out, read_err, write_err]
            child_fds = [read_in, write_out, write_err]
            for fd in child_fds:
                os.set_inheritable(fd, True)
            startup = StartupEx()
            startup.base.cb, startup.base.flags = ctypes.sizeof(startup), 0x100
            handles = (w.HANDLE * 3)(*[msvcrt.get_osfhandle(fd) for fd in child_fds])
            startup.base.stdin, startup.base.stdout, startup.base.stderr = handles
            attribute_size = size()
            k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(attribute_size))
            attribute_buffer = ctypes.create_string_buffer(attribute_size.value)
            if not k.InitializeProcThreadAttributeList(attribute_buffer, 1, 0, ctypes.byref(attribute_size)):
                raise OSError("HANDLE_LIST_FAILED")
            attributes = attribute_buffer
            if not k.UpdateProcThreadAttribute(attributes, 0, 0x00020002, handles, ctypes.sizeof(handles), None, None):
                raise OSError("HANDLE_LIST_FAILED")
            startup.attributes = ctypes.cast(attributes, ctypes.c_void_p)
            pi = ProcessInfo()
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline([request["command"], *request["args"]]))
            environment = ctypes.create_unicode_buffer("\0".join(k+"="+v for k, v in sorted(request["env"].items(), key=lambda p: p[0].upper())) + "\0\0")
            if not k.CreateProcessW(request["command"], command, None, None, True, 0x08000000 | 0x00000400 | 0x00000004 | 0x00080000,
                                    environment, request["cwd"], ctypes.byref(startup), ctypes.byref(pi)):
                raise OSError("PROCESS_CREATE_FAILED")
            self.process, self.thread, self.pid = pi.process, pi.thread, pi.pid
            # The primary thread cannot execute before it belongs to the job.
            if not k.AssignProcessToJobObject(self.job, self.process):
                raise OSError("JOB_ASSIGN_FAILED")
            if k.ResumeThread(self.thread) == 0xFFFFFFFF:
                raise OSError("PROCESS_RESUME_FAILED")
            k.CloseHandle(self.thread)
            self.thread = None
            for fd in child_fds:
                os.close(fd)
                fds.remove(fd)
            self.stdin = os.fdopen(write_in, "wb", buffering=0)
            self.stdout = os.fdopen(read_out, "rb", buffering=0)
            self.stderr = os.fdopen(read_err, "rb", buffering=0)
            fds.clear()
        except BaseException:
            if self.process:
                k.TerminateProcess(self.process, 1)
                k.WaitForSingleObject(self.process, 5000)
            self.close_handles()
            raise
        finally:
            if attributes is not None:
                k.DeleteProcThreadAttributeList(attributes)
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def poll(self):
        wait = self.k.WaitForSingleObject(self.process, 0)
        if wait == 258:
            return None
        if wait != 0:
            raise OSError("PROCESS_WAIT_FAILED")
        code = self.DWORD()
        if not self.k.GetExitCodeProcess(self.process, ctypes.byref(code)):
            raise OSError("PROCESS_STATUS_FAILED")
        return code.value

    def stop(self):
        if self.job and not self.k.TerminateJobObject(self.job, 1):
            raise OSError("JOB_TERMINATION_FAILED")

    def cleanup(self):
        self.stop()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            accounting = self.Accounting()
            if not self.k.QueryInformationJobObject(self.job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                raise OSError("JOB_ACCOUNTING_FAILED")
            if accounting.Active == 0:
                return "job_empty"
            time.sleep(0.02)
        return "unconfirmed"

    def close_handles(self):
        for key in ("thread", "process", "job"):
            handle = getattr(self, key, None)
            if handle:
                self.k.CloseHandle(handle)
                setattr(self, key, None)

    def close(self):
        for key in ("stdin", "stdout", "stderr"):
            handle = getattr(self, key, None)
            if handle:
                try:
                    handle.close()
                except OSError:
                    pass
        self.close_handles()


def main():
    if os.name != "nt":
        emit({"kind": "host_error", "code": "WINDOWS_REQUIRED"})
        return 1
    process = None
    finished = threading.Event()
    requested_stop = threading.Event()
    stream_error = threading.Event()
    try:
        request = checked_request()
        process = WindowsProcess(request)

        def commands():
            while not finished.is_set():
                line = sys.stdin.buffer.readline(4097)
                if not line:
                    DISCONNECTED.set()
                    return
                if line == b'{"op":"cancel"}\n':
                    requested_stop.set()
                else:
                    DISCONNECTED.set()
                    return

        def reader(handle, kind):
            try:
                while True:
                    chunk = os.read(handle.fileno(), 16384)
                    if not chunk:
                        break
                    emit({"kind": kind, "data": base64.b64encode(chunk).decode("ascii")})
            except OSError:
                stream_error.set()

        def writer():
            try:
                data = request["input"].encode("utf-8")
                offset = 0
                while offset < len(data):
                    offset += os.write(process.stdin.fileno(), data[offset:])
            except (BrokenPipeError, OSError):
                # A provider may close stdin when it has enough data; its terminal decides outcome.
                pass
            finally:
                process.stdin.close()

        command_thread = threading.Thread(target=commands, daemon=True)
        command_thread.start()
        emit({"kind": "started", "pid": process.pid, "containment": process.containment})
        readers = [threading.Thread(target=reader, args=(getattr(process, name), name), daemon=True) for name in ("stdout", "stderr")]
        for thread in readers:
            thread.start()
        writer_thread = threading.Thread(target=writer, daemon=True)
        writer_thread.start()
        deadline = time.monotonic() + request["timeout_ms"] / 1000
        stop = None
        while process.poll() is None:
            if DISCONNECTED.is_set():
                stop = "parent_disconnected"
            elif requested_stop.is_set():
                stop = "cancelled"
            elif time.monotonic() >= deadline:
                stop = "timeout"
            if stop:
                process.stop()
                break
            time.sleep(0.02)
        wait_until = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < wait_until:
            time.sleep(0.02)
        code = process.poll()
        cleanup = process.cleanup()
        for thread in readers:
            thread.join(timeout=2)
        if any(t.is_alive() for t in readers) or stream_error.is_set():
            cleanup = "unconfirmed"
        writer_thread.join(timeout=2)
        finished.set()
        emit({"kind": "done", "exit_code": code, "stop_reason": stop, "cleanup": cleanup})
        # Parent closes control stdin after the receipt; let its reader release
        # the buffered input lock before Python finalization.
        command_thread.join(timeout=3)
    except BaseException:
        # The request includes paths, prompts and environment values. Do not echo exceptions.
        emit({"kind": "host_error", "code": "PROCESS_HOST_FAILED"})
        return 1
    finally:
        finished.set()
        if process:
            try:
                process.stop()
            except OSError:
                pass
            process.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
