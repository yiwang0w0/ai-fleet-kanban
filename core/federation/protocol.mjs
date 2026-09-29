export class PeerError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CAPABILITIES = Object.freeze(["node-identity-v1", "peer-health-v1", "task-projection-sync-v1", "task-snapshot-v1", "source-epoch-recovery-v1"]);
export const SCOPES = Object.freeze(["peer:handshake", "peer:health", "sync:pull", "sync:ack"]);
export const PROTOCOL = Object.freeze({ min: 1, max: 1 });
export function bad(message) { throw new PeerError("BAD_INPUT", message); }
export function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(label + " 必须是对象");
  return value;
}
export function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(k => !allowed.includes(k))) bad(label + " 含未知字段；可选扩展放入 extensions");
}
export function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) bad(label + " 必须是规范小写 UUID");
  return value;
}
export function names(value, label, allow = null, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > 32 ||
      value.some(x => typeof x !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(x)) ||
      new Set(value).size !== value.length || (allow && value.some(x => !allow.includes(x)))) bad(label + " 无效");
  return [...value].sort();
}
export function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) bad("expected_version 必须是正安全整数");
  return value;
}
export function negotiateHello(body, peer, local) {
  keys(body, ["node_id", "sync_epoch", "protocol", "required_capabilities", "required_extensions", "extensions"], "hello");
  uuid(body.node_id, "node_id"); uuid(body.sync_epoch, "sync_epoch");
  if (body.node_id !== peer.peer_node_id || body.sync_epoch !== peer.peer_epoch)
    throw new PeerError("IDENTITY_MISMATCH", "节点身份或恢复 epoch 与凭据绑定不一致", 403);
  if (body.node_id === local.node_id) throw new PeerError("IDENTITY_CONFLICT", "对端不能使用本机身份", 409);
  keys(body.protocol, ["min", "max"], "protocol");
  const {min, max} = body.protocol;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min) bad("协议范围无效");
  const selected = Math.min(max, PROTOCOL.max);
  if (selected < Math.max(min, PROTOCOL.min))
    throw new PeerError("PROTOCOL_INCOMPATIBLE", "没有共同支持的协议版本", 426);
  const required = names(body.required_capabilities, "required_capabilities");
  const requiredExtensions = names(body.required_extensions ?? [], "required_extensions");
  if (required.some(x => !CAPABILITIES.includes(x)) || requiredExtensions.length)
    throw new PeerError("REQUIRED_FEATURE_UNSUPPORTED", "存在尚未支持的必需能力或扩展", 426);
  object(body.extensions ?? {}, "extensions");
  if (Buffer.byteLength(JSON.stringify(body.extensions ?? {})) > 2048) bad("可选扩展超过 2 KiB");
  return { protocol_version: selected, supported_protocol: PROTOCOL, capabilities: [...CAPABILITIES],
    node: {node_id: local.node_id, display_name: local.display_name, sync_epoch: local.sync_epoch},
    authorized: {peer_node_id: peer.peer_node_id, credential_version: peer.credential_version,
      scopes: peer.scopes, projects: peer.projects}, extensions: {} };
}
