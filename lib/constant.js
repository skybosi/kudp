const BROADWAY = "255.255.255.255"
const DEFAULT_PORT = 5328
const FD_BROAD = 3 // 广播占用fd
const FD_MULTI = 4 // 多播占用fd

const PROTONAME = 'kudp'
const VERSION = 0x0 // kudp version
const SEP = '/'

// 重传机制超时时间
const ACK_TIMEOUT = 400
const ACK_ECHO_TIMEOUT = 200
// 局域网最大数据包大小
const LAN_PACK_SIZE = 1024
// 广域网最大数据包大小
const WAN_PACK_SIZE = 512

const FACTOR = 4     // 默认放大因子
const BASE_SECTION = 256 // 基础段长度
const SECTION = FACTOR * BASE_SECTION

export {
  BROADWAY,
  DEFAULT_PORT,
  PROTONAME,
  FD_BROAD,
  FD_MULTI,
  VERSION,
  SEP,
  ACK_TIMEOUT,
  ACK_ECHO_TIMEOUT,
  LAN_PACK_SIZE,
  WAN_PACK_SIZE,
  SECTION,
};