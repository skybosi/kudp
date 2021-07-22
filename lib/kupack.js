/**
 * 固定头部 2 ~ 10 byte
 *  8      7      6      5      4      3      2      1      0
 *  +------+------+------+------+------+------+------+------+
 *  |       version      |               type               | 头部(1-byte)
 *  +------+------+------+------+------+------+------+------+
 *  |               remain             |     PCF     |  CF  | Flag
 *  +------+------+------+------+------+------+------+------+
 *  |              connection id(optional)                  |
 *  +------+------+------+------+------+------+------+------+
 *
 *
 * - 几个常量：
 *   - MTU：1370
 *   - MSS：1370 - 20 = 1350
 *
 * - 序列号:
 *   - tn + seq : `32bit`, 默认 tn:`5 bit`; seq: `28 bit`
 *   - tn: task number 任务号，表示同一个连接下，同时支持的不同数据块
 *     - 0 ：代表所有的task所在的connection，主要用于流控与拥塞控制，询问窗口使用
 *     - 1 ~ 9：协议内部保留使用，禁止被发送任务分配
 *   - seq: sequence number 序列号，默认情况下，随机在 `0 ~ 2^28` 生成，表示数据包的序号，随着数据包自增
 *
 * - 时间戳:
 *   - ts: timestamp 发送数据时的时间戳，相对于当天00:00:00的毫秒数，最大 `2^32 ms ~= 49.7` 天
 *   - 作用：
 *     1. 标记每个数据包发送的时间戳，在ack时回显发送端，用于计算rtt
 *     2. 标记因为 seq 回绕情况，无法区分序号相同的不同数据包
 *
 * - 窗口大小:
 *   - wnd: window, 接收端的最大接收窗口大小，单位：包个数，所以最大的数据字节数: `wnd * MTU`
 *
 * - 数据:
 *   - payload 长度: MSS - 固定报头 - 可变报头
 *
 * - ACK方式：
 *   - una：最大的未被确认的序号
 *   - ack: 当前的ACK的序号
 *   - sack：选择确认，是一个列表 (tn + seq) * n，其中tn被复用来表示次数，sack的数据包属于同一个Task的，禁止多Task串用
 *     - nack: 未被确认的seq，等价于ACK了0次
 *     - dack: 重复确认的seq，等价于ACK了m次，m >= 1
 *
 * - delta:
 *     - 表示接收方收到当前数据包，经过处理到ack发出时的时间消耗，单位ms，2byte，最大65535ms
 *     - 该值可以用来发现接收方的处理性能是否存在瓶颈，比如内存和cpu计算压力大
 *     - 如果存在累积确认的机制，需要排除这部分的时间消耗，避免计算误差
 *
 */
import { Errors, EHEADERTYPE, } from './errors';

(function (g, f) {
  const e = typeof exports == 'object' ? exports : typeof g == 'object' ? g : {};
  f(e);
  if (typeof define == 'function' && define.amd) {
    define('kupack', e);
  }
})(this, function (exports) {
  const utils = require('./common/utils')
  const SeqManage = require('./seq')
  const Buffer = require('./common/Buffer/Buffer')

  const VERSION = 0x0  // 版本号
  const VER = VERSION + ''

  const MTU = 1370
  const MSS = MTU - 20

  // 数据包类型
  const BROAD = 0x0   // 发送广播数据包
  const MULTI = 0x1   // 发送多播数据包
  const WSASK = 0x2   // 窗口的大小询问
  const WSANS = 0x3   // 窗口的大小回复通知
  const PINGS = 0x4   // 验证与维持对端是否仍然存活
  const RESET = 0x5   // 重置发送过程，可以是task级别，也可以是connection级别

  const BEGIN = 0x10  // 发送开始数据包
  const DOING = 0x11  // 大型数据包中间数据包
  const DONED = 0x12  // 结束数据包
  const BDODO = 0x13  // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
  const DTACK = 0x14  // 针对数据包的确认

  const MAXINT8 = 0xff
  const MAXINT32 = 0xffffffff
  // header反消息类型
  const rHeaderType = {
    "BROAD": BROAD,
    "MULTI": MULTI,
    "WSASK": WSASK,
    "WSANS": WSANS,
    "PINGS": PINGS,
    "RESET": RESET,
    "BEGIN": BEGIN,
    "DOING": DOING,
    "DONED": DONED,
    "BDODO": BDODO,
    "DTACK": DTACK,
  }

  // header消息类型
  const HeaderType = {
    // 发送数据包类型
    [BROAD]: "BROAD",
    [MULTI]: "MULTI",
    [WSASK]: "WSASK",
    [WSANS]: "WSANS",
    [PINGS]: "PINGS",
    [RESET]: "RESET",
    [BEGIN]: "BEGIN",
    [DOING]: "DOING",
    [DONED]: "DONED",
    [BDODO]: "BDODO",
    [DTACK]: "DTACK",
  }

  const TodayTimeStamp = new Date(new Date().toLocaleDateString()).getTime() // 当天00:00:00 毫秒
  const MonthTimeStamp = new Date(new Date().toLocaleDateString().substr(0, 6)).getTime() // 当月1日 00:00:00 毫秒
  const YearTimeStamp = new Date(new Date().getFullYear() + "/01/01 00:00:00").getTime() // 当年1月1日 00:00:00 毫秒

  // 获取当前时间距离当日00:00:00的毫秒数，作为数据包时间戳
  const getCurTimeStamp = () => {
    return new Date().getTime() - TodayTimeStamp
  }

  /**
   * 广播包时的kind类型
   */
  const KindMap = {
    0: [1, '']
  }

  /**
   * 连接迁移时的连接号
   */
  class ConnectId {
    constructor(cf, low, high) {
      this.cf = cf || 0
      switch (this.cf) {
        case 0:
          this.size = 0
          break;
        case 1:
          this.size = 1
          this.low = (low && low != 0) ? low : utils.RandomNum(0, MAXINT8)
          break;
        case 2:
          this.size = 4
          this.low = (low && low != 0) ? low : utils.RandomNum(0, MAXINT32)
          break;
        case 3:
          this.size = 8
          this.high = (high && high != 0) ? high : utils.RandomNum(0, MAXINT32)
          this.low = (low && low != 0) ? low : utils.RandomNum(0, MAXINT32)
          break;
      }
    }
    get length() { return this.size }
    toBuffer() {
      var buf = null
      switch (this.cf) {
        case 0:
          break;
        case 1:
          buf = new Buffer(1)
          buf.writeUInt8(this.low, 0);
          break;
        case 2:
          buf = new Buffer(4)
          buf.writeUInt32BE(this.low, 0);  //write the low order bits
          break;
        case 3:
          buf = new Buffer(8)
          buf.writeUInt32BE(this.low, 0);  //write the low order bits
          buf.writeUInt32BE(this.high, 4); //write the high order bits (shifted over)
          break;
      }
      return buf
    }
    toString() {
      return (this.high ? this.high.toString(2) : "") + (this.low ? this.low.toString(2) : "")
    }
    toHex() {
      return "0x" + (this.high ? this.high.toString(16).replace(/(.{2})/g, '$1').trim() : "") +
        (this.low ? this.low.toString(16).replace(/(.{2})/g, '$1').trim() : "")
    }
    equals(c) {
      return (c instanceof ConnectId && this.high == c.high && this.low == c.low)
    }
  }

  /**
   * 数据包头解析
   * 8      7      6      5      4      3      2      1      0
   * +------+------+------+------+------+------+------+------+
   * |       version      |               type               | 头部(1-byte)
   * +------+------+------+------+------+------+------+------+
   * |               remain             |     PCF     |  CF  | Flag
   * +------+------+------+------+------+------+------+------+
   * |              connection id(optional)                  |
   * +------+------+------+------+------+------+------+------+
   */
  class Header {
    constructor(type, pcf = 0, cf = 0) {
      this.flag = 0
      this.vt = VERSION << 5
      if (!this.validType(type)) {
        throw Errors(EHEADERTYPE, "invalid type", type);
      } else {
        this.setType(type);
      }
      if (!this.validPcf(pcf)) {
        throw Errors(EHEADERTYPE, "invalid pcf", pcf);
      } else {
        this.setPcf(pcf)
      }
      if (!this.validCf(cf)) {
        throw Errors(EHEADERTYPE, "invalid cf", cf);
      } else {
        this.setCf(cf)
      }
      this.cid = new ConnectId(cf)
    }
    // 检测有效的类型
    validType(mtype) {
      return HeaderType[mtype]
    }
    // 检测有效的pcf
    validPcf(pcf) {
      return pcf >= 0 && pcf <= 3
    }
    // 检测有效的类型
    validCf(cf) {
      return cf >= 0 && cf <= 3
    }
    // 设置mtype的每一个bit
    setType(type) {
      // 重置vt所有bit为 ???0 0000
      this.vt &= 0xe0;
      return this.vt |= type
    }
    // 设置Pcf
    setPcf(pcf) {
      // 重置flag所有bit为 0000 00??
      this.flag &= 0x3;
      return this.flag |= (pcf << 2)
    }
    // 设置Cf
    setCf(cf) {
      // 重置flag所有bit为 0000 ??00
      this.flag &= 0xc;
      return this.flag |= cf
    }
    // header属性
    get length() {
      return 1 + 1 + this.cid.length
    }
    get Type() { return (this.vt & 0x1f) >>> 0; }
    get Version() { return (this.vt & 0xe0) >>> 5; }
    get Pcf() { return (this.flag & 0xc) >>> 2; }
    get Cf() { return (this.flag & 0x3) >>> 0; }
    get Cid() { return this.cid.toHex(); }
    get isFin() { return (BDODO === this.Type || DONED === this.Type) }
    get isBegin() { return (BEGIN === this.Type) }
    get isAck() { return (DTACK === this.Type) }
    get isCtrlPackage() { return this.Type < BEGIN }
    get isDataPackage() { return this.Type >= BEGIN }
    // 从数据反构造一个header
    static New(vt, flag) {
      let pcf = (flag & 0xc) >>> 2
      let cf = (flag & 0x3) >>> 0
      return new Header(vt, pcf, cf);
    }
    toString() {
      if (this.cid.length == 0) {
        return utils.Pad(this.vt.toString(2), 8) + " " + utils.Pad(this.flag.toString(2), 8);
      }
      return utils.Pad(this.vt.toString(2), 8) + " " + utils.Pad(this.flag.toString(2), 8) + " " + this.cid.toString();
    }
    equals(header) {
      if (header instanceof Header) {
        if (this.vt != header.vt || this.flag != header.flag) {
          return false
        } else {
          return this.cid.equals(header.cid)
        }
      }
      return false
    }
    copy() {
      var header = Header.New(this.Type, this.flag)
      header.cid = this.cid
      return header
    }
    // 获取header信息
    info() {
      return {
        type: this.Type, // type
        pcf: this.Pcf,
        cf: this.Cf,
        cid: this.cid,
        cids: this.Cid,
        str: this.toString(),
        desc: HeaderType[this.Type],
      }
    }

    // 测试
    static testHeader() {
      for (let mtype in rHeaderType) {
        for (let pcf = 0; pcf <= 3; pcf++) {
          for (let cf = 0; cf <= 3; cf++) {
            var head = new Header(rHeaderType[mtype], pcf, cf);
            console.log("Header Tesing Version:", head.Version);
            console.log("Header Tesing Pcf:", head.Pcf);
            console.log("Header Tesing Cf:", head.Cf);
            console.log("Header Tesing cid:", head.cid);
            console.log("Header Tesing vt toString:", head.vt.toString());
            console.log("Header Tesing flag toString:", head.flag.toString());
            console.log("Header Tesing toString:", head.toString());
            console.log("Header Tesing isFin:", head.isFin);
            console.log("Header Tesing isBegin:", head.isBegin);
            console.log("Header Tesing isAck:", head.isAck);
            console.log("Header Tesing isCtrlPackage:", head.isCtrlPackage);
            console.log("Header Tesing isDataPackage:", head.isDataPackage);
            console.log("Header Tesing info:", head.info());
            var head2 = head.copy()
            console.log("Header Tesing equals:", head.equals(head2));
          }
        }
      }
    }
  }

  /**
   * 数据包body解析
   */
  class Body {
    constructor(type, pcf = 0, tnseq, ctx = {}) {
      this.type = type
      this.pcf = pcf
      this.bbuf = null
      this.ctx = ctx
      if (!utils.isNull(tnseq)) {
        this.bbuf = Body.encodeBody(type, pcf, tnseq, ctx)
      }
    }

    // 依据不同数据包类型，填充相关数据
    static encodeBody(type, pcf, tnseq, ctx) {
      var bbuf = null
      switch (type) {
        case BROAD: // "BROAD"
          /**
           * header-0: PCF = 0b00 (default)
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       0      0      0  | Type: 0
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   0  |   0  | Flag = 0
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0: PCF = 0b00 (default)
           *     空
           *
           * header-1: PCF = 0b01 -> 支持选项
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       0      0      0  | Type: 0
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      1  |   0      0  | Flag = 4
           *     +------+------+------+------+------+------+------+------+
           * bbuf-1: PCF = 0b01 -> 支持选项
           *     0             2                           ?
           *     +------+------+---------------------------+
           *     | kind | len  |            value          |
           *     +------+------+---------------------------+
           *     len: 表示后面value的大小，最大255字节
           *     kind：【建议】由于是广播包，仅在局域网中生效，建议选项考虑局域网相关场景设计
           *       - kind：0 ~ 63    64个 协议后期扩展占用，自定义场景禁止使用
           *       - kind: 64 ~ 223  160个 自定义场景使用范围
           *       - kind: 224 ~ 255 32个 实验期间使用
           *
           *     广播包添加选项后，建议不要超过MTU，减小IP分包可能性
           */
          switch (pcf) {
            case 0:
              break;
            case 1:
              bbuf = new Buffer(MSS)
              for (let k in ctx.kind) {
                let v = ctx.kind[k]
                bbuf.writeUInt8(v.kind)
                bbuf.writeUInt8(KindMap[v.kind][0])
                if (Buffer.isBuffer(v.value)) {
                  bbuf.writeBuffer(v.value)
                } else {
                  bbuf.write(v.value)
                }
              }
              break;
            default:
              break;
          }
          break;
        case MULTI: // "MULTI"
          /**
           * 暂时保留
           */
          break;
        case WSASK: // "WSASK"
          /**
           * header-0: PCF = 0b00 (default) 单任务询问，用于task级别的流控和拥塞控制
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       0      1      0  | Type: 2
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0:
           *     0                             4       5                     8(byte)
           *     +-----------------------------+-------+---------------------+
           *     |            ts(4)            | tn(1) |         seq(3)      |
           *     +-----------------------------+-------+---------------------+
           *
           * header-1: PCF = 0b01 连接询问，连接级别的的窗口询问，用于连接级别的流控和拥塞控制
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       0      1      0  | Type: 2
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      1  |   ?      ?  | Flag = 4 | 5 | 6 | 7
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-1:
           *     0                             4       5                     8(byte)
           *     +-----------------------------+-------+---------------------+
           *     |            ts(4)            |   0   |           0         |
           *     +-----------------------------+-------+---------------------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(8)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              break;
            case 1:
              bbuf = new Buffer(8)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(0)                 // tn + seq
              break;
            default:
              break;
          }
          break;
        case WSANS: // "WSANS"
          /**
           * header-0: PCF = 0b00 (default) 单任务询问回复，用于task级别的流控和拥塞控制
           *      8      7      6      5      4      3      2      1      0
           *      +------+------+------+------+------+------+------+------+
           *      |   0      0      0  |   0     0       0      1      1  | Type: 3
           *      +------+------+------+------+------+------+------+------+
           *      |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *      +------+------+------+------+------+------+------+------+
           *      |              connection id(optional)                  | cid
           *      +------+------+------+------+------+------+------+------+
           * bbuf-0:
           *      0                             4       5                     8
           *      +-----------------------------+-------+---------------------+
           *      |         echo ts(4)          | tn(1) |       seq(3)        |
           *      +-------------------------------------+---------------------+
           *      |    delta(2)  |         wnd(4)       |
           *      +--------------+----------------------+
           *
           * header-1: PCF = 0b01 连接询问回复，连接级别的的窗口询问，用于连接级别的流控和拥塞控制
           *      8      7      6      5      4      3      2      1      0
           *      +------+------+------+------+------+------+------+------+
           *      |   0      0      0  |   0     0       0      1      1  | Type: 3
           *      +------+------+------+------+------+------+------+------+
           *      |   x      x      x      x  |   0      1  |   ?      ?  | Flag = 4 | 5 | 6 | 7
           *      +------+------+------+------+------+------+------+------+
           *      |              connection id(optional)                  | cid
           *      +------+------+------+------+------+------+------+------+
           * bbuf-1:
           *      0                             4       5                     8
           *      +-----------------------------+-------+---------------------+
           *      |         echo ts(4)          |   0   |           0         |
           *      +-------------------------------------+---------------------+
           *      |    delta(2)  |         wnd(4)       |
           *      +--------------+----------------------+
           *
           * header-2: PCF = 0b10 单任务窗口通知，用于task级别的流控和拥塞控制
           *      8      7      6      5      4      3      2      1      0
           *      +------+------+------+------+------+------+------+------+
           *      |   0      0      0  |   0     0       0      1      1  | Type: 3
           *      +------+------+------+------+------+------+------+------+
           *      |   x      x      x      x  |   1      0  |   ?      ?  | Flag = 8 | 9 | 10 | 11
           *      +------+------+------+------+------+------+------+------+
           *      |              connection id(optional)                  | cid
           *      +------+------+------+------+------+------+------+------+
           * bbuf-2:
           *      0                             4       5                     8
           *      +-----------------------------+-------+---------------------+
           *      |         echo ts(4)          |   0   |           0         |
           *      +-------------------------------------+---------------------+
           *      |    delta(2)  |         wnd(4)       |
           *      +--------------+----------------------+
           *
           * header-3: PCF = 0b11 连接窗口通知，连接级别的的窗口询问，用于连接级别的流控和拥塞控制
           *      8      7      6      5      4      3      2      1      0
           *      +------+------+------+------+------+------+------+------+
           *      |   0      0      0  |   0     0       0      1      1  | Type: 3
           *      +------+------+------+------+------+------+------+------+
           *      |   x      x      x      x  |   1      1  |   ?      ?  | Flag = 12 | 13 | 14 | 15
           *      +------+------+------+------+------+------+------+------+
           *      |              connection id(optional)                  | cid
           *      +------+------+------+------+------+------+------+------+
           * bbuf-3:
           *      0                             4       5                     8
           *      +-----------------------------+-------+---------------------+
           *      |         echo ts(4)          |   0   |           0         |
           *      +-------------------------------------+---------------------+
           *      |    delta(2)  |         wnd(4)       |
           *      +--------------+----------------------+
           */
          switch (pcf) {
            case 0: case 2:
              bbuf = new Buffer(14)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(ctx.delta || 0)    // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              break;
            case 1: case 3:
              bbuf = new Buffer(14)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(0)                 // tn + seq
              bbuf.writeUInt16BE(ctx.delta || 0)    // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              break;
            default:
              break;
          }
          break;
        case PINGS:
          /**
           * header-0: PCF = 0b00 (default) 单任务询问回复，用于task级别的流控和拥塞控制
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       0      1      1  | Type: 3
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   0      0  | Flag = 0
           *     +------+------+------+------+------+------+------+------+
           *
           * body-0:
           *     0                             4
           *     +-----------------------------+
           *     |            ts(4)            |
           *     +-----------------------------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(4)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              break;
            default:
              break;
          }
          break;
        case RESET:
          /**
           * header-0: PCF = 0b00 (default) 重置发送过程，可以是task级别，也可以是connection级别,tn = 0 表示connection级别
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       1      0      1  | Type: 5
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           *
           * body-0:
           *     0                             4       5
           *     +-----------------------------+-------+
           *     |            ts(4)            | tn(1) |
           *     +-----------------------------+-------+
           *
           * header-1: PCF = 0b01 重置发送过程，强制撤回已经发送的该task的内容消息，仅仅作用于task级别
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       1      0      1  | Type: 5
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      1  |   ?      ?  | Flag = 4 | 5 | 6 | 7
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           *
           * body-1:
           *     0                             4       5
           *     +-----------------------------+-------+
           *     |            ts(4)            | tn(1) |
           *     +-----------------------------+-------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(5)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt8(ctx.tn)               // tn >= 0
              break;
            case 1:
              bbuf = new Buffer(5)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt8(ctx.tn)               // tn > 0
              break;
            default:
              break;
          }
          break;
        case BEGIN: // "BEGIN"
          /**
           * header-0:
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       0      0      0  | Type: 16
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0:
           *       0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |            ts(4)            | tn(1) |         seq(3)      |
           *     +-----------------------------+-------+---------------------+
           *     |                  payload(MSS - 1 - 4 - 4)                 |
           *     +-----------------------------------------------------------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              if (Buffer.isBuffer(ctx.payload)) {
                bbuf.writeBuffer(ctx.payload)       // payload
              } else {
                bbuf.write(ctx.payload || "")       // payload
              }
              break;
            default:
              break;
          }
          break;
        case DOING: // "DOING"
          /**
           * header-0:
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       0      0      1  | Type: 17
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0:
           *       0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |            ts(4)            | tn(1) |         seq(3)      |
           *     +-----------------------------+-------+---------------------+
           *     |                  payload(MSS - 1 - 4 - 4)                 |
           *     +-----------------------------------------------------------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              if (Buffer.isBuffer(ctx.payload)) {
                bbuf.writeBuffer(ctx.payload)       // payload
              } else {
                bbuf.write(ctx.payload || "")       // delta
              }
              break;
            default:
              break;
          }
          break;
        case DONED: // "DONED"
          /**
           * header-0:
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       0      1      0  | Type: 18
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0:
           *       0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |            ts(4)            | tn(1) |         seq(3)      |
           *     +-----------------------------+-------+---------------------+
           *     |                  payload(MSS - 1 - 4 - 4)                 |
           *     +-----------------------------------------------------------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              if (Buffer.isBuffer(ctx.payload)) {
                bbuf.writeBuffer(ctx.payload)       // payload
              } else {
                bbuf.write(ctx.payload || "")       // payload
              }
              break;
            default:
              break;
          }
          break;
        case BDODO: // "BDODO"
          /**
           * header-0: PCF = 0b00 (default) 0 否 采用流式传输，收集多个BDD凑成 MSS 大小的数据包
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       0      1      1  | Type: 19
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0:
           *     0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |            ts(4)            | tn(1) |         seq(3)      |
           *     +-----------------------------+-------+---------------------+
           *     |                   payload(optional)                       | payload
           *     +-----------------------------------------------------------+
           *
           * header-1: PCF = 0b01 是 采用流式传输，尽可能再不过多等待的情况下，收集多个BDD凑成 MSS 大小的数据包
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       0      1      1  | Type: 19
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      1  |   ?      ?  | Flag = 4 | 5 | 6 | 7
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-1:
           *     0                             4
           *     +-----------------------------+
           *     |            ts(4)            |
           *     +-----------------------------+--------------+----------+
           *     | tn1(1) |       seq1(3)      |    len1(2)   | payload1 |
           *     +--------+--------------------+--------------+----------+
           *     | tn2(1) |       seq2(3)      |    len2(2)   | payload2 |
           *     +--------+--------------------+--------------+----------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              if (Buffer.isBuffer(ctx.payload)) {
                bbuf.writeBuffer(ctx.payload)       // payload
              } else {
                bbuf.write(ctx.payload || "")       // payload
              }
              break;
            case 1:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              for (let a in ctx.tnseqs) {
                bbuf.writeUInt32BE(a.tnseq)         // each tn + seq
                bbuf.writeUInt16BE(a.payload.length)// each len TODO 是否需要2byte
                if (Buffer.isBuffer(a.payload)) {
                  bbuf.writeBuffer(a.payload)       // each payload
                } else {
                  bbuf.write(a.payload || "")       // each payload
                }
              }
              break;
            default:
              break;
          }
          break;
        case DTACK: // "DTACK"
          /**
           * header-0: PCF = 0b00 -> ack
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       1      0      0  | Type: 20
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-0: PCF = 0b00 -> ack
           *     0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |         echo ts(4)          | tn(1) |       seq(3)        |  tn + seq = ack
           *     +-----------------------------+-------+---------------------+
           *     |    delta(2)  |       wnd(4)         |
           *     +--------------+----------------------+
           *
           * header-1: PCF = 0b01 -> ack + una (default)
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       1      0      0  | Type: 20
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      1  |   ?      ?  | Flag = 4 | 5 | 6 | 7
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-1: PCF = 0b01 -> ack + una (default)
           *     0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |         echo ts(4)          | tn(1) |       seq(3)        |  tn + seq = ack
           *     +-----------------------------+-------+---------------------+
           *     |    delta(2)  |       wnd(4)         |       una(4)        |
           *     +--------------+----------------------+---------------------+
           *
           * header-2: PCF = 0b10 -> ack + una + sack， 必须是同一个连接，建议是同一个task，但允许不同task
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       1      0      0  | Type: 20
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   1      0  |   ?      ?  | Flag = 8 | 9 | 10 | 11
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-2: PCF = 0b10 -> ack + una + sack， 必须是同一个连接，建议是同一个task，但允许不同task
           *     0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |         echo ts(4)          | tn(1) |       seq(3)        |  tn + seq = ack
           *     +-----------------------------+-------+---------------------+
           *     |    delta(2)  |       wnd(4)         |       una(4)        |
           *     +--------------+--------------+-------+---------------------+
           *     | tn1(1)|       seq1(3)       | tn2(1)|       seq2(3)       |
           *     +-------+---------------------+-------+---------------------+
           *     | tn3(1)|       seq3(3)       | tnn(1)|       seqn(3)       |
           *     +-------+---------------------+-------+---------------------+
           *     最大sack量 m = (
           *       MSS - 1     // 1byte 固定头
           *           - 4     // 4byte 时间戳
           *           - 4     // 4byte tn + seq
           *           - 4     // 4byte 接收窗口大小
           *           - 4     // 4byte una
           *     ) / 4 = (MSS - 17) / 4 = (1350 - 17) / 4 = 333 个
           *
           * header-3: PCF = 0b11 -> ack + sack， 必须是同一个连接
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   1     0       1      0      0  | Type: 20
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   1      1  |   ?      ?  | Flag = 12 | 13 | 14 | 15
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           * bbuf-3: PCF = 0b11 -> ack + sack， 必须是同一个连接，建议是同一个task，但允许不同task
           *     0                             4       5                     8
           *     +-----------------------------+-------+---------------------+
           *     |         echo ts(4)          | tn(1) |       seq(3)        |  tn + seq = ack
           *     +-----------------------------+-------+---------------------+
           *     |    delta(2)  |       wnd(4)         |    tn1 + seq1(4)    |
           *     +--------------+--------------+-------+---------------------+
           *     | tn2(1)|       seq2(3)       | tn3(1)|       seq3(3)       |
           *     +-------+---------------------+-------+---------------------+
           *     | tn4(1)|       seq4(3)       | tnn(1)|       seqn(3)       |
           *     +-------+---------------------+-------+---------------------+
           *     最大sack量 m = (
           *       MSS - 1     // 1byte 固定头
           *           - 4     // 4byte 时间戳
           *           - 4     // 4byte tn + seq
           *           - 4     // 4byte 接收窗口大小
           *     ) / 4 = (MSS - 13) / 4 = (1350 - 13) / 4 = 334 个
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(14)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(ctx.delta || 0)    // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              break;
            case 1:
              bbuf = new Buffer(18)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(ctx.delta || 0)    // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              bbuf.writeUInt32BE(ctx.una)           // una
              break;
            case 2:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(ctx.delta || 0)    // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              bbuf.writeUInt32BE(ctx.una)           // una
              for (let atnseq in ctx.tnseqs) {
                bbuf.writeUInt32BE(atnseq)          // each tn + seq
              }
              break;
            case 3:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(getCurTimeStamp()) // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(ctx.delta || 0)    // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              for (let atnseq in ctx.tnseqs) {
                bbuf.writeUInt32BE(atnseq)          // each tn + seq
              }
              break;
            default:
              break;
          }
          break;
        default:
          throw Errors(EHEADERTYPE, "invalid type", type);
      }
      // 获取真正存储数据的部分buffer
      if (bbuf && Buffer.isBuffer(bbuf)) {
        bbuf = bbuf.sliceValid()
      }
      return bbuf
    }

    // 依据不同数据包类型，拆分数据包
    static decodeBody(type, pcf, buffer) {
      var ret = new Body(type, pcf)
      ret.bbuf = buffer
      ret.ctx = null
      var buflen = buffer ? buffer.length : 0
      switch (type) {
        case BROAD: // "BROAD"
          switch (pcf) {
            case 0:
              break;
            case 1:
              ret.ctx = {}
              ret.ctx.kind = []
              for (var i = 0; i < buflen;) {
                let kind = buffer.readUInt8(i++)
                let len = buffer.readUInt8(i++)
                let value = buffer.readUInt8(i)
                ret.ctx.kind.push({ kind: kind, len: len, value: value })
                i += len
              }
              break;
            default:
              break;
          }
          break;
        case MULTI: // "MULTI"
          /**
           * 暂时保留
           */
          break;
        case WSASK: // "WSASK"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4) ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8) tn + seq
              break;
            case 1:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4) ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8) tn + seq
              break;
            default:
              break;
          }
          break;
        case WSANS: // "WSANS"
          ret.ctx = {}
          switch (pcf) {
            case 0: case 2:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.delta = buffer.readUInt16BE(8)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10)   // [10, 14) rwnd
              break;
            case 1: case 3:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.delta = buffer.readUInt16BE(8)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10)   // [10, 14) rwnd
              break;
            default:
              break;
          }
          break;
        case PINGS:
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              break;
            default:
              break;
          }
          break;
        case RESET:
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tn = buffer.readUInt8(4)         // [5, 6]   tn
              break;
            case 1:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tn = buffer.readUInt8(4)         // [5, 6]   tn
              break;
            default:
              break;
          }
          break;
        case BEGIN: // "BEGIN"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.payload = buffer.read(8)         // [8, )  payload
              break;
            default:
              break;
          }
          break;
        case DOING: // "DOING"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.payload = buffer.read(8)         // [8, )  payload
              break;
            default:
              break;
          }
          break;
        case DONED: // "DONED"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.payload = buffer.read(8)         // [8, )  payload
              break;
            default:
              break;
          }
          break;
        case BDODO: // "BDODO"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.payload = buffer.read(8)         // [8, )  payload
              break;
            case 1:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseqs = []
              for (var i = 4; i < buflen;) {
                let atnseq = buffer.readUInt32BE(i); i += 4  // each tn + seq
                let alen = buffer.readUInt16BE(i); i += 2    // each len TODO 是否需要2byte
                let apayload = buffer.read(i, i + alen)      // each payload
                ret.ctx.tnseqs.push({ tnseq: atnseq, len: alen, payload: apayload })
                i += alen
              }
              break;
            default:
              break;
          }
          break;
        case DTACK: // "DTACK"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.delta = buffer.readUInt16BE(8)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10)   // [10, 14)  rwnd
              break;
            case 1:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.delta = buffer.readUInt16BE(8)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10)   // [10, 14)  rwnd
              ret.ctx.una = buffer.readUInt32BE(14)    // [14, 18)  una
              break;
            case 2:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.delta = buffer.readUInt16BE(8)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10)   // [10, 14)  rwnd
              ret.ctx.una = buffer.readUInt32BE(14)    // [14, 18)  una
              ret.ctx.tnseqs = []
              for (var i = 18; i < buflen; i += 4) {
                let atnseq = buffer.readUInt32BE(i);     // each tn + seq
                ret.ctx.tnseqs.push(atnseq)
              }
              break;
            case 3:
              ret.ctx.ts = buffer.readUInt32BE(0)      // [0, 4)   ts
              ret.ctx.tnseq = buffer.readUInt32BE(4)   // [4, 8)   tn + seq
              ret.ctx.delta = buffer.readUInt16BE(8)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10)   // [10, 14)  rwnd
              ret.ctx.tnseqs = []
              for (var i = 14; i < buflen; i += 4) {
                let atnseq = buffer.readUInt32BE(i);     // each tn + seq
                ret.ctx.tnseqs.push(atnseq)
              }
              break;
            default:
              break;
          }
          break;
        default:
          throw Errors(EHEADERTYPE, "invalid type", type);
      }
      return ret
    }

    get length() {
      return this.bbuf ? this.bbuf.length : 0
    }

    get buffer() {
      return this.bbuf ? this.bbuf : null
    }

    New(type, pcf = 0, tnseq, ctx = {}) {
      return new Body(type, pcf, tnseq, ctx)
    }

    equals(b) {
      if (b instanceof Body) {
        if (b.type != this.type || b.pcf != this.pcf) {
          return false
        }
        if (utils.isNull(this.bbuf)) {
          return b.bbuf == this.bbuf
        } else if (!this.bbuf.equals(b.bbuf)) {
          return false
        }
        return true
      }
      return false
    }

    copy() {
      var b = new (this.type, this.pcf)
      if (Buffer.isBuffer(this.bbuf)) {
        b.bbuf = new Buffer(this.length)
        this.bbuf.copy(b.bbuf)
      }
      return b
    }

    toHex() {
      return this.bbuf ? this.bbuf.inspect() : ""
    }

    static testBody() {
      var seqer = new SeqManage();
      for (let type in rHeaderType) {
        for (let pcf = 0; pcf <= 3; pcf++) {
          for (let cf = 0; cf <= 3; cf++) {
            let mtype = rHeaderType[type]
            let tnseq = seqer.malloc()
            let { tn } = SeqManage.decode(tnseq)
            let body = null
            let ctx = {}
            switch (mtype) {
              case BROAD: //"BROAD"
                switch (pcf) {
                  case 0:
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 1:
                    ctx.kind = [{ kind: 0, value: "hello BROAD" }]
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case MULTI: //"MULTI"
                break;
              case WSASK: //"WSASK"
                switch (pcf) {
                  case 0:
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 1:
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case WSANS: //"WSANS"
                ctx = { delta: 210, rwnd: 102 }
                switch (pcf) {
                  case 0: case 2:
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 1: case 3:
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case PINGS:
                switch (pcf) {
                  case 0:
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case RESET:
                switch (pcf) {
                  case 0:
                    ctx.tn = tn
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 0:
                    ctx.tn = tn
                    body = new Body(mtype, pcf, tnseq, ctx)
                  default:
                    break;
                }
                break;
              case BEGIN: //"BEGIN"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BEGIN" }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DOING: //"DOING"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DOING" }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DONED: //"DONED"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DONED" }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case BDODO: //"BDODO"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BDODO 1" }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 1:
                    ctx = [{ tnseq: tnseq, payload: "hello BDODO " + tnseq }, { tnseq: tnseq + 1, payload: "hello BDODO " + tnseq + 1 },]
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DOING" }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DTACK: //"DTACK"
                switch (pcf) {
                  case 0:
                    ctx = { delta: 103, rwnd: 10, }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 1:
                    ctx = { delta: 103, rwnd: 10, una: tnseq + 10 }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 2:
                    ctx = { delta: 103, rwnd: 10, una: tnseq + 10, tnseqs: [tnseq, tnseq + 3, tnseq + 4] }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  case 3:
                    ctx = { delta: 103, rwnd: 10, tnseqs: [tnseq, tnseq + 3, tnseq + 4] }
                    body = new Body(mtype, pcf, tnseq, ctx)
                    break;
                  default:
                    break;
                }
                break;
            }
            if (body) {
              let unbody = Body.decodeBody(mtype, pcf, body.buffer)
              console.log("Type:%s[%s] PCF:%d CF:%d length:%d\n%s\n%s\n%s", type, mtype, pcf, cf, body.length, unbody.toHex(), body.toHex(), "Body Tesing equals:", body.equals(unbody))
              // console.log(unbody, body, "Body Tesing equals:", body.equals(unbody))
            }
          }
        }
      }
    }
  }

  /**
   * package 解析器
   */
  class Package {
    constructor(type, pcf = 0, cf = 0, tn, seq, ctx = {}) {
      this.buffer = null
      if (!utils.isNull(type)) {
        this.tnseq = SeqManage.encode(tn, seq)
        this.header = new Header(type, pcf, cf)
        this.version = this.header.Version
        this.body = new Body(this.header.Type, this.header.Pcf, this.tnseq, ctx)
        this.buffer = this.build(this.header, this.body);
        this.cid = this.header.Cid
      }
    }

    // 构建pack
    build(header, body) {
      return Package.pack(header, body);
    }

    equals(p) {
      return p instanceof Package && this.header.equals(p.header) && this.body.equals(p.body);
    }

    toHex() {
      return this.buffer ? this.buffer.inspect() : "";
    }

    get length() { return this.buffer ? this.buffer.length : 0; }

    // 编码数据包结构
    static pack(header, body) {
      let msg = new Buffer(body.length + header.length);
      /** 写入header数据 */
      msg.writeUInt8(header.vt);      // 0
      msg.writeUInt8(header.flag);    // 1
      if (0 != header.Cf) {
        msg.writeBuffer(header.cid.toBuffer())
      }
      if (body.buffer) {
        msg.writeBuffer(body.buffer)
      }
      // console.log("pack ....", msg.inspect())
      return msg
    }

    // 解码数据包
    static unpack(buffer) {
      let pkg = new Package()
      let msg = new Buffer(buffer)
      // console.log("unpack ....", msg.inspect())
      /** 从buffer 读出header */
      pkg.buffer = msg
      let vt = msg.readUInt8(0);       // 0
      let flag = msg.readUInt8(1);     // 1
      pkg.header = Header.New(vt, flag)
      switch (pkg.header.Cf) {
        case 1:
          pkg.header.cid = new ConnectId(pkg.header.Cf, msg.readUInt8(2));
          pkg.cid = pkg.header.Cid
          break;
        case 2:
          pkg.header.cid = new ConnectId(pkg.header.Cf, msg.readUInt32BE(2));
          pkg.cid = pkg.header.Cid
          break
        case 3:
          pkg.header.cid = new ConnectId(pkg.header.Cf, msg.readUInt32BE(2), msg.readUInt32BE(6));
          pkg.cid = pkg.header.Cid
          break;
      }
      pkg.version = pkg.header.Version
      let bbuffer = msg.length > pkg.header.length ? msg.slice(pkg.header.length) : null
      pkg.body = Body.decodeBody(pkg.header.Type, pkg.header.Pcf, bbuffer, pkg.header.length)
      return pkg
    }

    static testPackage() {
      var seqer = new SeqManage();
      for (let type in rHeaderType) {
        for (let pcf = 0; pcf <= 3; pcf++) {
          for (let cf = 0; cf <= 3; cf++) {
            let mtype = rHeaderType[type]
            let tnseq = seqer.malloc()
            let { tn, seq } = SeqManage.decode(tnseq)
            let pack = null
            let ctx = {}
            switch (mtype) {
              case BROAD: //"BROAD"
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 1:
                    ctx.kind = [{ kind: 0, value: "hello BROAD 💮🌹🌺🌻🌼" }]
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case MULTI: //"MULTI"
                break;
              case WSASK: //"WSASK"
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 1:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case WSANS: //"WSANS"
                ctx = { delta: 210, rwnd: 102 }
                switch (pcf) {
                  case 0: case 2:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 1: case 3:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case PINGS: //"PINGS"
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case RESET: //"RESET"
                ctx = { tn: tn }
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 1:
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case BEGIN: //"BEGIN"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BEGIN 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DOING: //"DOING"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DOING 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DONED: //"DONED"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DONED 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case BDODO: //"BDODO"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BDODO 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 1:
                    ctx = [{ tnseq: tnseq, payload: "hello BDODO " + tnseq }, { tnseq: tnseq + 1, payload: "hello BDODO " + tnseq + 1 },]
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BDODO 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DTACK: //"DTACK"
                switch (pcf) {
                  case 0:
                    ctx = { delta: 103, rwnd: 10, }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 1:
                    ctx = { delta: 103, rwnd: 10, una: tnseq + 10 }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 2:
                    ctx = { delta: 103, rwnd: 10, una: tnseq + 10, tnseqs: [tnseq, tnseq + 3, tnseq + 4] }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  case 3:
                    ctx = { delta: 103, rwnd: 10, tnseqs: [tnseq, tnseq + 3, tnseq + 4] }
                    pack = new Package(mtype, pcf, cf, tn, seq, ctx)
                    break;
                  default:
                    break;
                }
                break;
            }
            if (pack) {
              let unpack = Package.unpack(pack.buffer)
              console.log("Type:%s[%s] PCF:%d CF:%d length:%d\n%s\n%s\n%s", type, mtype, pcf, cf, pack.length, unpack.toHex(), pack.toHex(), "Package Tesing equals:", pack.equals(unpack))
              // console.log(unpack, pack, "Package Tesing equals:", pack.equals(unpack))
            }
          }
        }
      }
    }
  }

  exports.Header = Header;
  exports.Body = Body;
  exports.Package = Package;

  exports.BROAD = BROAD; // 发送广播数据包
  exports.MULTI = MULTI; // 发送多播数据包
  exports.WSASK = WSASK; // 窗口的大小询问
  exports.WSANS = WSANS; // 窗口的大小回复通知

  exports.BEGIN = BEGIN; // 发送开始数据包
  exports.DOING = DOING; // 大型数据包中间数据包
  exports.DONED = DONED; // 结束数据包
  exports.BDODO = BDODO; // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
  exports.DTACK = DTACK; // 针对数据包的确认
});