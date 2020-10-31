// 局域网最大数据包大小
export const LAN_PACK_SIZE = 1024
// 广域网最大数据包大小
export const WAN_PACK_SIZE = 512

/** 数据包类型 */
export const BROAD = 0x0  // 广播数据包
export const MULTI = 0x1  // 多播数据包
export const BEGIN = 0x2  // 首个数据包
export const DOING = 0x3  // 大型数据包中间数据包
export const DONED = 0x4  // 结束数据包
export const BDD = 0x5    // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
