"""Windows process host: Job lifetime control and optional offline AppContainer."""
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
    if not isinstance(value, dict) or set(value) not in ({"command", "args", "cwd", "env", "input", "pins", "timeout_ms"}, {"command", "args", "cwd", "env", "input", "pins", "timeout_ms", "isolation"}):
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
    isolation = value.get('isolation')
    if isolation is not None:
        if not isinstance(isolation, dict) or set(isolation) != {'kind', 'network', 'memory_limit_bytes', 'process_limit'} or isolation['kind'] != 'windows-appcontainer' or isolation['network'] != 'none' or type(isolation['memory_limit_bytes']) is not int or not 67108864 <= isolation['memory_limit_bytes'] <= 2147483648 or type(isolation['process_limit']) is not int or not 1 <= isolation['process_limit'] <= 64:
            raise ValueError('BAD_ISOLATION')
    return value


class AppContainer:
    """Per-run Windows identity. Grants only the run workspace and private staged inputs.

    No capabilities or loopback exemptions are requested. Package ACLs are on
    run-specific directories only; a removed profile is never reused.
    """
    def __init__(self, request):
        import shutil
        import tempfile
        import uuid
        from pathlib import Path, PureWindowsPath
        from ctypes import wintypes as w
        self.root = None
        self.sid = ctypes.c_void_p()
        self.created = False
        self.name = 'ai-fleet-check-' + str(uuid.uuid4())
        self.report = {"kind": "windows-appcontainer", "profile_name": self.name,
                       "network": "none", "capability_count": 0, "token_verified": False,
                       "memory_limit_bytes": request['isolation']['memory_limit_bytes'],
                       "process_limit": request['isolation']['process_limit'],
                       "profile_removed": False, "staging_removed": False}
        self.u = ctypes.WinDLL('userenv', use_last_error=True)
        self.a = ctypes.WinDLL('advapi32', use_last_error=True)
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        self.u.CreateAppContainerProfile.argtypes = [w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, ctypes.c_void_p, w.DWORD, ctypes.POINTER(ctypes.c_void_p)]
        self.u.CreateAppContainerProfile.restype = ctypes.c_long
        self.u.DeleteAppContainerProfile.argtypes = [w.LPCWSTR]
        self.u.DeleteAppContainerProfile.restype = ctypes.c_long
        self.a.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
        self.a.ConvertSidToStringSidW.restype = w.BOOL
        self.a.FreeSid.argtypes = [ctypes.c_void_p]
        self.a.FreeSid.restype = ctypes.c_void_p
        self.k.LocalFree.argtypes = [ctypes.c_void_p]
        self.k.LocalFree.restype = ctypes.c_void_p
        self.k.GetWindowsDirectoryW.argtypes = [w.LPWSTR, w.UINT]
        self.k.GetWindowsDirectoryW.restype = w.UINT
        windows = ctypes.create_unicode_buffer(32768)
        length = self.k.GetWindowsDirectoryW(windows, len(windows))
        if not 0 < length < len(windows):
            raise OSError('WINDOWS_DIRECTORY_FAILED')
        self.windows = windows.value
        self.icacls = os.path.join(self.windows, 'System32', 'icacls.exe')
        try:
            cwd = Path(request['cwd'])
            if not cwd.is_absolute() or cwd == Path(cwd.anchor) or str(cwd).startswith('\\\\'):
                raise ValueError('UNSAFE_SANDBOX_DIRECTORY')
            # No junction/symlink/hardlink may turn the workspace ACL grant into an outside grant.
            for path in [cwd, *cwd.parents]:
                if path.lstat().st_file_attributes & 0x400:
                    raise ValueError('UNSAFE_SANDBOX_DIRECTORY')
            count = 0
            for parent, dirs, files in os.walk(cwd, followlinks=False):
                for name in [*dirs, *files]:
                    info = (Path(parent) / name).lstat()
                    count += 1
                    if count > 50000 or info.st_file_attributes & 0x400 or name in files and info.st_nlink != 1:
                        raise ValueError('UNSAFE_SANDBOX_ENTRY')
            hr = self.u.CreateAppContainerProfile(self.name, self.name, 'AI Fleet offline verification', None, 0, ctypes.byref(self.sid))
            if hr < 0:
                raise OSError('APPCONTAINER_PROFILE_FAILED')
            self.created = True
            sid_text = w.LPWSTR()
            if not self.a.ConvertSidToStringSidW(self.sid, ctypes.byref(sid_text)):
                raise OSError('APPCONTAINER_SID_FAILED')
            self.sid_text = sid_text.value
            self.k.LocalFree(sid_text)
            self.temp_parent = Path(tempfile.gettempdir()).resolve()
            self.root = Path(tempfile.mkdtemp(prefix='ai-fleet-sandbox-', dir=self.temp_parent))
            inputs, home = self.root / 'inputs', self.root / 'home'
            inputs.mkdir()
            (home / 'temp').mkdir(parents=True)
            (home / 'roaming').mkdir()
            (home / 'local').mkdir()
            mapped = {}
            copied_bytes = 0
            for pin in request['pins']:
                original = Path(os.path.realpath(pin['path']))
                drive = PureWindowsPath(str(original)).drive
                if len(drive) != 2 or drive[1] != ':' or not drive[0].isascii() or not drive[0].isalpha():
                    raise ValueError('LOCAL_SANDBOX_PIN_REQUIRED')
                destination = inputs / drive[0].upper()
                for part in original.parts[1:]:
                    destination /= part
                destination.parent.mkdir(parents=True, exist_ok=True)
                key = os.path.normcase(os.path.realpath(original))
                if key in mapped:
                    continue
                if copied_bytes + original.stat().st_size > 512 * 1024 * 1024:
                    raise ValueError('SANDBOX_INPUT_LIMIT')
                with open(original, 'rb') as source, open(destination, 'xb') as target:
                    while True:
                        chunk = source.read(min(1024 * 1024, 512 * 1024 * 1024 - copied_bytes + 1))
                        if not chunk:
                            break
                        copied_bytes += len(chunk)
                        if copied_bytes > 512 * 1024 * 1024:
                            raise ValueError('SANDBOX_INPUT_LIMIT')
                        target.write(chunk)
                with open(destination, 'rb') as target:
                    if hashlib.file_digest(target, 'sha256').hexdigest() != pin['sha256']:
                        raise ValueError('SANDBOX_PIN_CHANGED')
                mapped[key] = str(destination)
            self.grant(str(inputs), 'RX')
            self.grant(str(home), 'M')
            self.grant(str(cwd), 'M')
            request['command'] = mapped[os.path.normcase(os.path.realpath(request['command']))]
            request['args'] = [mapped.get(os.path.normcase(os.path.realpath(arg)), arg) if os.path.isabs(arg) else arg for arg in request['args']]
            env = {k: v for k, v in request['env'].items() if k.lower() not in ['systemroot','windir','path','userprofile','localappdata','appdata','temp','tmp','homedrive','homepath']}
            env.update({'SystemRoot': self.windows, 'WINDIR': self.windows,
                        'PATH': os.path.dirname(request['command']) + ';' + os.path.join(self.windows, 'System32'),
                        'USERPROFILE': str(home), 'LOCALAPPDATA': str(home / 'local'), 'APPDATA': str(home / 'roaming'),
                        'TEMP': str(home / 'temp'), 'TMP': str(home / 'temp')})
            request['env'] = env
        except BaseException:
            self.close()
            raise

    def grant(self, path, rights):
        result = subprocess.run([self.icacls, path, '/grant', '*' + self.sid_text + ':(OI)(CI)(' + rights + ')', '/T', '/L', '/Q'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000, timeout=30)
        if result.returncode != 0:
            raise OSError('SANDBOX_ACL_FAILED')

    def verify_token(self, process):
        from ctypes import wintypes as w
        self.a.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
        self.a.OpenProcessToken.restype = w.BOOL
        self.a.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
        self.a.GetTokenInformation.restype = w.BOOL
        self.a.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.a.EqualSid.restype = w.BOOL
        self.k.CloseHandle.argtypes = [w.HANDLE]
        self.k.CloseHandle.restype = w.BOOL
        token = w.HANDLE()
        if not self.a.OpenProcessToken(process, 8, ctypes.byref(token)):
            raise OSError('SANDBOX_TOKEN_FAILED')
        try:
            def info(kind):
                needed = w.DWORD()
                self.a.GetTokenInformation(token, kind, None, 0, ctypes.byref(needed))
                if needed.value < 4 or needed.value > 65536:
                    raise OSError('SANDBOX_TOKEN_FAILED')
                buffer = ctypes.create_string_buffer(needed.value)
                if not self.a.GetTokenInformation(token, kind, buffer, needed, ctypes.byref(needed)):
                    raise OSError('SANDBOX_TOKEN_FAILED')
                return buffer
            is_container, capabilities, identity = info(29), info(30), info(31)
            if w.DWORD.from_buffer(is_container).value != 1 or w.DWORD.from_buffer(capabilities).value != 0 or not self.a.EqualSid(ctypes.c_void_p.from_buffer(identity), self.sid):
                raise OSError('SANDBOX_TOKEN_MISMATCH')
            self.report['token_verified'] = True
        finally:
            self.k.CloseHandle(token)

    def close(self):
        import shutil
        from pathlib import Path
        if self.created:
            if self.u.DeleteAppContainerProfile(self.name) == 0:
                self.created = False
                self.report['profile_removed'] = True
        if self.root is not None and self.root.exists():
            # Windows shutil.rmtree removes junctions themselves, not their targets.
            root = self.root.resolve()
            if root.parent == self.temp_parent and root.name.startswith('ai-fleet-sandbox-') and not self.root.lstat().st_file_attributes & 0x400:
                try:
                    shutil.rmtree(self.root)
                    self.report['staging_removed'] = True
                except OSError:
                    pass
        if self.sid.value:
            self.a.FreeSid(self.sid)
            self.sid = ctypes.c_void_p()


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
        self.sandbox = None
        fds = []
        attributes = None
        try:
            if request.get('isolation') is not None:
                self.sandbox = AppContainer(request)
            self.job = k.CreateJobObjectW(None, None)
            if not self.job:
                raise OSError("JOB_CREATE_FAILED")
            limits = ExtendedLimits()
            limits.Basic.Flags = 0x2000  # KILL_ON_JOB_CLOSE; never allow breakaway.
            if self.sandbox:
                limits.Basic.Flags |= 0x8 | 0x200  # ACTIVE_PROCESS and aggregate JOB_MEMORY limits.
                limits.Basic.ActiveLimit = request['isolation']['process_limit']
                limits.JobMemory = request['isolation']['memory_limit_bytes']
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
            attribute_count = 2 if self.sandbox else 1
            k.InitializeProcThreadAttributeList(None, attribute_count, 0, ctypes.byref(attribute_size))
            attribute_buffer = ctypes.create_string_buffer(attribute_size.value)
            if not k.InitializeProcThreadAttributeList(attribute_buffer, attribute_count, 0, ctypes.byref(attribute_size)):
                raise OSError("HANDLE_LIST_FAILED")
            attributes = attribute_buffer
            if not k.UpdateProcThreadAttribute(attributes, 0, 0x00020002, handles, ctypes.sizeof(handles), None, None):
                raise OSError("HANDLE_LIST_FAILED")
            if self.sandbox:
                class SecurityCapabilities(ctypes.Structure):
                    _fields_ = [('sid', ctypes.c_void_p), ('capabilities', ctypes.c_void_p), ('count', w.DWORD), ('reserved', w.DWORD)]
                capabilities = SecurityCapabilities(self.sandbox.sid, None, 0, 0)
                if not k.UpdateProcThreadAttribute(attributes, 0, 0x00020009, ctypes.byref(capabilities), ctypes.sizeof(capabilities), None, None):
                    raise OSError('APPCONTAINER_ATTRIBUTE_FAILED')
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
            if self.sandbox:
                self.sandbox.verify_token(self.process)
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
            if self.sandbox:
                self.sandbox.close()
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
        if self.sandbox:
            self.sandbox.close()


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
        emit({"kind": "started", "pid": process.pid, "containment": process.containment, **({"sandbox": process.sandbox.report} if process.sandbox else {})})
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
        if process.sandbox and cleanup == 'job_empty':
            process.sandbox.close()
        emit({"kind": "done", "exit_code": code, "stop_reason": stop, "cleanup": cleanup, **({"sandbox": process.sandbox.report} if process.sandbox else {})})
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
