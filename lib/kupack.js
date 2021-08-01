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
  const Buffer = require('./common/Buffer/Buffer')

  const VERSION = 0x0  // 版本号
  const PROTONAME = 'kudp' + VERSION

  const MTU = 1370
  const MSS = MTU - 20

  const SEP = '/'

  // kudp task seq
  const MAX_TASK_SEQ = ((~(0)) >>> 0) + 1                 // task_seq最大值
  const SEQ_BYTE_COUNT = 32                               // 4byte的task_seq号
  const TASK_BIT_COUNT = 8                                // task号占的bit位
  const MAX_TASK_NUM = 1 << TASK_BIT_COUNT                // task号最大值
  const MIN_TASK_NUM = 10                                 // task号最大值
  const SEQ_BIT_COUNT = SEQ_BYTE_COUNT - TASK_BIT_COUNT   // seq号占的bit位
  const MAX_SEQ_NUM = ((-1 >>> TASK_BIT_COUNT) + 1) >>> 0 // seq号最大值
  /************************************************************* SeqManage *************************************************************/
  /**
   * kudp数据包序号管理器，针对每一个连接独立管理
   * 1. task: 0 ~ 9 被协议内部占用
   * 2. 同一个连接内新建 task不可重复
   * 3. 不同连接内新建的task不干扰
   */
  class SeqManage {
    constructor() {
      this.seqs = { '-1': { size: 0, wrap: 0 } }
    }
    get size() {
      return this.seqs["-1"]['size']
    }
    get wrap() {
      return this.seqs["-1"]['wrap']
    }

    /**
     * @param {number} size
     * @returns {number} tn  一个新的数据包发送，申请一个新的isn
     */
    malloc() {
      return this.getTaskNum()
    }

    /**
     * 获取一个可用的任务号, 并随机生成一个isn
     */
    getTaskNum() {
      let i = MIN_TASK_NUM
      for (const seq in this.seqs) {
        if (Number(seq) != i && i < MAX_TASK_NUM) {
          let tn = i >>> 0
          let seq = utils.RandomNum(0, MAX_SEQ_NUM) >>> 0
          this.seqs[i] = { isn: seq, cursor: seq, wrap: 0, tn: tn }
          this.seqs["-1"]['size']++
          return { tn, seq }
        }
        i++;
      }
      throw Errors(ENOTALLOCISN, "no match tn");
    }

    /**
     * @param {number} tn a tn
     * 数据包确认完后，即时释放和清除
     */
    free(tn) {
      if (!this.seqs[tn]) {
        return false
      }
      return delete this.seqs[tn]
    }

    /**
     * 获取下一个可用的seq
     * @param {number} tn will return a seq from a tn
     * @param {boolean} loop true loop use seq number, false not loop
     * @returns {boolean} seq a next seq can be use
     */
    next(tn) {
      let seq = this.seqs[tn]['cursor']
      let wrap = (seq + 1 >= MAX_SEQ_NUM) // seq 回绕
      if (wrap) {
        this.seqs['-1']['wrap']++
        this.seqs[tn]['wrap']++
        this.seqs[tn]['cursor'] = 0
      } else {
        this.seqs[tn]['cursor']++
      }
      return seq
    }

    /**
     * @param {number} seq a seq number
     * @returns {object} 获取定位一个seq属于哪个isn段内
     */
    location(task_seq) {
      let { tn, seq } = SeqManage.decode(task_seq)
      if (!this.seqs[tn]) {
        throw Errors(ENOTALLOCISN, "no match tn");
      }
      return { tn, seq, task_info: this.info(tn) }
    }

    /**
     * @param {number} tn
     * @returns {object} 获取isn对应的所有信息
     */
    info(tn) {
      return this.seqs[tn];
    }

    /**
     * 清空并释放所有
     */
    clear() {
      this.seqs = { '-1': { size: 0, wrap: 0 } }
    }

    static decode(task_seq) {
      if (task_seq < 0 || task_seq >= MAX_TASK_SEQ) {
        return null
      }
      let tn = (task_seq & (0xff << SEQ_BIT_COUNT)) >>> SEQ_BIT_COUNT
      let seq = (task_seq & (~(0xff << SEQ_BIT_COUNT))) >>> 0
      return { tn, seq }
    }

    static encode(tn, seq) {
      if (utils.isNull(tn) || tn < 0 || tn >= MAX_TASK_NUM) {
        return null
      }
      if (utils.isNull(seq) || seq < 0 || seq >= MAX_SEQ_NUM) {
        return null
      }
      let task_seq = 0
      task_seq |= (tn << SEQ_BIT_COUNT)
      task_seq |= seq
      task_seq = task_seq >>> 0
      return task_seq
    }

    /**
     * 测试函数
     */
    static testSeqManage() {
      let seqm = new SeqManage();
      var i = 0;
      // test max tn exception
      while (i < MAX_TASK_NUM) {
        if (seqm.wrap > 0) {
          console.log(tn, seqm)
        }
        try {
          let tn = seqm.malloc();
          console.log(tn, seqm)
        } catch (error) {
          break;
        }
        i++
      }
      // test clear SeqManage
      seqm.clear();
      // test wrap SeqManage
      let { tn, seq } = seqm.malloc()
      while (true) {
        let task_seq_each = seqm.next(tn)
        if (seqm.location(task_seq_each)['task_info']['cursor'] + 10 >= MAX_SEQ_NUM) {
          console.log("will wrap:", tn, task_seq_each, seqm)
        }
        let { task_info } = seqm.location(task_seq_each)
        if (task_info['wrap'] > 0) {
          console.log("seq wrap:", tn, task_seq_each, seqm)
          let task_seq_each = seqm.next(tn)
          console.log("seq wraped:", tn, task_seq_each, seqm)
          break;
        }
      }
      // test decode
      console.log(SeqManage.decode(0x00000000))   // 0x00-0x000000
      console.log(SeqManage.decode(0x01000000))   // 0x01-0x000000
      console.log(SeqManage.decode(0x00ffffff))   // 0x00-0xffffff
      console.log(SeqManage.decode(0x01ffffff))   // 0x01-0xffffff
      console.log(SeqManage.decode(0xff000000))   // 0xff-0x000000
      console.log(SeqManage.decode(0xfe000000))   // 0xfe-0x000000
      console.log(SeqManage.decode(0xffffffff))   // 0xff-0xffffff
      console.log(SeqManage.decode(0xfeffffff))   // 0xfe-0xffffff
      // test encode
      console.log(SeqManage.encode(0x00, 0x000000))   // 0x00-0x000000
      console.log(SeqManage.encode(0x01, 0xffffff))   // 0x01-0xffffff
      console.log(SeqManage.encode(0x12, 0xf34ff3))   // 0x12-0xf34ff3
      console.log(SeqManage.encode(0x00, 0xfedfff))   // 0x00-0xfedfff
      console.log(SeqManage.encode(0x21, 0xff23ff))   // 0x21-0xff23ff
      console.log(SeqManage.encode(0xf2, 0x000000))   // 0xf2-0x000000
      console.log(SeqManage.encode(0xfe, 0x002300))   // 0xfe-0x002300
      console.log(SeqManage.encode(0xf5, 0xffe4ff))   // 0xf5-0xffe4ff
      console.log(SeqManage.encode(0xfe, 0xffffff))   // 0xfe-0xffffff
    }
  }

  // 数据包类型
  const BROAD = 0x0   // 发送广播数据包
  const MULTI = 0x1   // 发送多播数据包
  const WSASK = 0x2   // 窗口的大小询问
  const WSANS = 0x3   // 窗口的大小回复通知
  const PINGS = 0x4   // 验证与维持对端是否仍然存活
  const RESET = 0x5   // 重置发送过程，可以是task级别，也可以是connection级别
  const CLOSE = 0x6   // 关闭连接，最终释放所有的资源，正在传输的将继续，但不再处理其他的新任务

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
    "CLOSE": CLOSE,
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
    [CLOSE]: "CLOSE",
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
    get cid() { return this.toHex() }
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
      return "0x" + (this.high ? this.high.toString(16).replace(/(.{2})/g, '$1').trim() : "0") +
        (this.low ? this.low.toString(16).replace(/(.{2})/g, '$1').trim() : "0")
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
    constructor(type, pcf = 0, cf = 0, connid) {
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
      this.connid = connid
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
      return utils.isNull(this.connid) ? (1 + 1) : (1 + 1 + this.connid.length)
    }
    get Type() { return (this.vt & 0x1f) >>> 0; }
    get Version() { return (this.vt & 0xe0) >>> 5; }
    get Pcf() { return (this.flag & 0xc) >>> 2; }
    get Cf() { return (this.flag & 0x3) >>> 0; }
    get Cid() { return this.connid ? this.connid.toHex() : null; }
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
      if (this.connid.length == 0) {
        return utils.Pad(this.vt.toString(2), 8) + " " + utils.Pad(this.flag.toString(2), 8);
      }
      return utils.Pad(this.vt.toString(2), 8) + " " + utils.Pad(this.flag.toString(2), 8) + " " + this.connid.toString();
    }
    toHex() {
      if (this.connid.length == 0) {
        return "0x" + this.vt.toString(16).replace(/(.{2})/g, '$1').trim() + this.flag.toString(16).replace(/(.{2})/g, '$1').trim();
      }
      return "0x" + this.vt.toString(16).replace(/(.{2})/g, '$1').trim() + this.flag.toString(16).replace(/(.{2})/g, '$1').trim() + " " + this.connid.toHex();
    }
    equals(header) {
      if (header instanceof Header) {
        if (this.vt != header.vt || this.flag != header.flag) {
          return false
        } else {
          return this.connid.equals(header.connid)
        }
      }
      return false
    }
    copy() {
      var header = Header.New(this.Type, this.flag)
      header.connid = this.connid
      return header
    }
    // 获取header信息
    info() {
      return {
        type: this.Type, // type
        pcf: this.Pcf,
        cf: this.Cf,
        connid: this.connid,
        cid: this.Cid,
        str: this.toString(),
        desc: HeaderType[this.Type],
      }
    }

    // 测试
    static testHeader() {
      for (let mtype in rHeaderType) {
        for (let pcf = 0; pcf <= 3; pcf++) {
          for (let cf = 0; cf <= 3; cf++) {
            var connid = new ConnectId(cf)
            var head = new Header(rHeaderType[mtype], pcf, cf, connid);
            console.log("Header Tesing Version:", head.Version);
            console.log("Header Tesing Pcf:", head.Pcf);
            console.log("Header Tesing Cf:", head.Cf);
            console.log("Header Tesing cid:", head.Cid);
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
    constructor(type, pcf = 0, tnseq, ctx = {}, init = false) {
      this.type = type
      this.pcf = pcf
      this.ctx = ctx
      if (!init) {
        this.bbuf = Body.encodeBody(type, pcf, tnseq, ctx)
      }
    }

    // 依据不同数据包类型，填充相关数据
    static encodeBody(type, pcf, tnseq, ctx) {
      var bbuf = null
      var ts = getCurTimeStamp()
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
                let len = v.value ? v.value.length : 0
                bbuf.writeUInt8(v.kind)
                bbuf.writeUInt8(len)
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
           *     0                             4       5
           *     +-----------------------------+-------+
           *     |            ts(4)            | tn(1) |
           *     +-----------------------------+-------+
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
           *     0                             4       5
           *     +-----------------------------+-------+
           *     |            ts(4)            |   0   |
           *     +-----------------------------+-------+
           */
          switch (pcf) {
            case 0:
              bbuf = new Buffer(5)
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt8(0)                    // tn
              break;
            case 1:
              bbuf = new Buffer(5)
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt8(ctx.tn)               // tn
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
              var delta = (ts - (ctx.rcv_ts || ts))
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(delta)             // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              break;
            case 1: case 3:
              bbuf = new Buffer(14)
              var delta = (ts - (ctx.rcv_ts || ts))
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(0)                 // tn + seq
              bbuf.writeUInt16BE(delta)             // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              break;
            default:
              break;
          }
          break;
        case PINGS: // "PINGS"
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
              bbuf.writeUInt32BE(ts)                // ts
              break;
            default:
              break;
          }
          break;
        case RESET: // "RESET"
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
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt8(ctx.tn)               // tn >= 0
              break;
            case 1:
              bbuf = new Buffer(5)
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt8(ctx.tn)               // tn > 0
              break;
            default:
              break;
          }
          break;
        case CLOSE: // "CLOSE"
          /**
           * header-0: PCF = 0b00 (default) 关闭连接，最终释放所有的资源，正在传输的将继续，但不再处理其他的新任务
           *     8      7      6      5      4      3      2      1      0
           *     +------+------+------+------+------+------+------+------+
           *     |   0      0      0  |   0     0       1      1      0  | Type: 6
           *     +------+------+------+------+------+------+------+------+
           *     |   x      x      x      x  |   0      0  |   ?      ?  | Flag = 0 | 1 | 2 | 3
           *     +------+------+------+------+------+------+------+------+
           *     |              connection id(optional)                  | cid
           *     +------+------+------+------+------+------+------+------+
           *
           * body-0:
           *     空
           */
          switch (pcf) {
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
              bbuf.writeUInt32BE(ts)                // ts
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
              bbuf.writeUInt32BE(ts)                // ts
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
              bbuf.writeUInt32BE(ts)                // ts
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
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              if (Buffer.isBuffer(ctx.payload)) {
                bbuf.writeBuffer(ctx.payload)       // payload
              } else {
                bbuf.write(ctx.payload || "")       // payload
              }
              break;
            case 1:
              bbuf = new Buffer(MSS)
              bbuf.writeUInt32BE(ts)                // ts
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
              var delta = (ts - (ctx.rcv_ts || ts))
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(delta)             // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              break;
            case 1:
              bbuf = new Buffer(18)
              var delta = (ts - (ctx.rcv_ts || ts))
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(delta)             // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              bbuf.writeUInt32BE(ctx.una)           // una
              break;
            case 2:
              bbuf = new Buffer(MSS)
              var delta = (ts - (ctx.rcv_ts || ts))
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(delta)             // delta
              bbuf.writeUInt32BE(ctx.rwnd)          // rwnd
              bbuf.writeUInt32BE(ctx.una)           // una
              for (let atnseq in ctx.tnseqs) {
                bbuf.writeUInt32BE(atnseq)          // each tn + seq
              }
              break;
            case 3:
              bbuf = new Buffer(MSS)
              var delta = (ts - (ctx.rcv_ts || ts))
              bbuf.writeUInt32BE(ts)                // ts
              bbuf.writeUInt32BE(tnseq)             // tn + seq
              bbuf.writeUInt16BE(delta)             // delta
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
    static decodeBody(type, pcf, buffer, offset) {
      var ret = new Body(type, pcf, null, null, true)
      ret.bbuf = buffer
      ret.ctx = null
      ret.tn = null
      ret.seq = 0
      ret.ts = null
      var buflen = buffer ? buffer.length : 0
      switch (type) {
        case BROAD: // "BROAD"
          switch (pcf) {
            case 0:
              break;
            case 1:
              ret.ctx = {}
              ret.ctx.kind = []
              for (var i = offset; i < buflen;) {
                let kind = buffer.readUInt8(i++)
                let len = buffer.readUInt8(i++)
                let value = buffer.read(i, i + len)
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
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              ret.tn = buffer.readUInt8(4 + offset)             // [5, 5) tn
              break;
            case 1:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              ret.tn = buffer.readUInt8(4 + offset)             // [5, 5) tn
              break;
            default:
              break;
          }
          break;
        case WSANS: // "WSANS"
          ret.ctx = {}
          switch (pcf) {
            case 0: case 2:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.delta = buffer.readUInt16BE(8 + offset)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10 + offset)   // [10, 14) rwnd
              break;
            case 1: case 3:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.delta = buffer.readUInt16BE(8 + offset)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10 + offset)   // [10, 14) rwnd
              break;
            default:
              break;
          }
          break;
        case PINGS: // "PINGS"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              break;
            default:
              break;
          }
          break;
        case RESET: // "RESET"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4)   ts
              ret.tn = buffer.readUInt8(4 + offset)             // [5, 6]   tn
              break;
            case 1:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4)   ts
              ret.tn = buffer.readUInt8(4 + offset)             // [5, 6]   tn
              break;
            default:
              break;
          }
          break;
        case CLOSE: // "CLOSE"
          switch (pcf) {
            default:
              break;
          }
          break;
        case BEGIN: // "BEGIN"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.payload = buffer.read(8 + offset)         // [8, )  payload
              break;
            default:
              break;
          }
          break;
        case DOING: // "DOING"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.payload = buffer.read(8 + offset)         // [8, )  payload
              break;
            default:
              break;
          }
          break;
        case DONED: // "DONED"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.payload = buffer.read(8 + offset)         // [8, )  payload
              break;
            default:
              break;
          }
          break;
        case BDODO: // "BDODO"
          ret.ctx = {}
          switch (pcf) {
            case 0:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.payload = buffer.read(8 + offset)         // [8, )  payload
              break;
            case 1:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4)   ts
              ret.ctx.tnseqs = []
              for (var i = 4 + offset; i < buflen;) {
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
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.delta = buffer.readUInt16BE(8 + offset)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10 + offset)   // [10, 14)  rwnd
              break;
            case 1:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.delta = buffer.readUInt16BE(8 + offset)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10 + offset)   // [10, 14)  rwnd
              ret.ctx.una = buffer.readUInt32BE(14 + offset)    // [14, 18)  una
              break;
            case 2:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.delta = buffer.readUInt16BE(8 + offset)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10 + offset)   // [10, 14)  rwnd
              ret.ctx.una = buffer.readUInt32BE(14 + offset)    // [14, 18)  una
              ret.ctx.tnseqs = []
              for (var i = 18 + offset; i < buflen; i += 4) {
                let atnseq = buffer.readUInt32BE(i);     // each tn + seq
                ret.ctx.tnseqs.push(atnseq)
              }
              break;
            case 3:
              ret.ts = buffer.readUInt32BE(0 + offset)          // [0, 4) ts
              var tnseq = buffer.readUInt32BE(4 + offset)       // [4, 8) tn + seq
              var { tn, seq } = SeqManage.decode(tnseq)
              ret.tn = tn, ret.seq = seq
              ret.ctx.delta = buffer.readUInt16BE(8 + offset)   // [8, 10)  delta
              ret.ctx.rwnd = buffer.readUInt32BE(10 + offset)   // [10, 14)  rwnd
              ret.ctx.tnseqs = []
              for (var i = 14 + offset; i < buflen; i += 4) {
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

    static New(type, pcf = 0, tnseq, ctx = {}) {
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
                ctx = { tn: tn }
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
              case CLOSE:
                switch (pcf) {
                  default:
                    body = new Body(mtype, pcf, tnseq, ctx)
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
    constructor(type, pcf = 0, cf = 0, tn, seq, connid, ctx = {}) {
      this.pbuffer = null
      if (!utils.isNull(type)) {
        this.tnseq = SeqManage.encode(tn, seq)
        this.header = new Header(type, pcf, cf, connid)
        this.version = this.header.Version
        this.body = new Body(this.header.Type, this.header.Pcf, this.tnseq, ctx)
        this.pbuffer = this.build(this.header, this.body);
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
      return this.pbuffer ? this.pbuffer.inspect() : "";
    }

    get length() { return this.pbuffer ? this.pbuffer.length : 0; }

    get buffer() { return this.pbuffer ? this.pbuffer.buffer : null; }

    // 编码数据包结构
    static pack(header, body) {
      let msg = new Buffer(body.length + header.length);
      /** 写入header数据 */
      msg.writeUInt8(header.vt);      // 0
      msg.writeUInt8(header.flag);    // 1
      if (0 != header.Cf) {
        msg.writeBuffer(header.connid.toBuffer())
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
      pkg.pbuffer = msg
      let vt = msg.readUInt8(0);       // 0
      let flag = msg.readUInt8(1);     // 1
      pkg.header = Header.New(vt, flag)
      switch (pkg.header.Cf) {
        case 1:
          pkg.header.connid = new ConnectId(pkg.header.Cf, msg.readUInt8(2));
          pkg.cid = pkg.header.Cid
          pkg.connid = pkg.header.connid     // TODO 规范cid Cid
          break;
        case 2:
          pkg.header.connid = new ConnectId(pkg.header.Cf, msg.readUInt32BE(2));
          pkg.cid = pkg.header.Cid
          pkg.connid = pkg.header.connid
          break
        case 3:
          pkg.header.connid = new ConnectId(pkg.header.Cf, msg.readUInt32BE(2), msg.readUInt32BE(6));
          pkg.cid = pkg.header.Cid
          pkg.connid = pkg.header.connid
          break;
        default:
          pkg.cid = "0x"
          pkg.connid = null
      }
      pkg.version = pkg.header.Version   // 版本
      pkg.mtype = pkg.header.Type        // 数据包类型
      pkg.pcf = pkg.header.Pcf           // pcf: package ctrl flag
      pkg.cf = pkg.header.Cf             // cf: connection flag
      pkg.body = Body.decodeBody(pkg.mtype, pkg.pcf, msg, pkg.header.length)
      return pkg
    }

    static testPackage() {
      var seqer = new SeqManage();
      for (let type in rHeaderType) {
        for (let pcf = 0; pcf <= 3; pcf++) {
          for (let cf = 0; cf <= 3; cf++) {
            var connid = new ConnectId(cf)
            let mtype = rHeaderType[type]
            let tnseq = seqer.malloc()
            let { tn, seq } = SeqManage.decode(tnseq)
            let pack = null
            let ctx = {}
            switch (mtype) {
              case BROAD: //"BROAD"
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 1:
                    ctx.kind = [{ kind: 0, value: "hello BROAD 💮🌹🌺🌻🌼" }]
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case MULTI: //"MULTI"
                break;
              case WSASK: //"WSASK"
                ctx = { tn: tn }
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 1:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case WSANS: //"WSANS"
                ctx = { delta: 210, rwnd: 102 }
                switch (pcf) {
                  case 0: case 2:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 1: case 3:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case PINGS: //"PINGS"
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case RESET: //"RESET"
                ctx = { tn: tn }
                switch (pcf) {
                  case 0:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 1:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case CLOSE: //"CLOSE"
                switch (pcf) {
                  default:
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                }
                break;
              case BEGIN: //"BEGIN"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BEGIN 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DOING: //"DOING"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DOING 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DONED: //"DONED"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello DONED 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case BDODO: //"BDODO"
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BDODO 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 1:
                    ctx = [{ tnseq: tnseq, payload: "hello BDODO " + tnseq }, { tnseq: tnseq + 1, payload: "hello BDODO " + tnseq + 1 },]
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                switch (pcf) {
                  case 0:
                    ctx = { payload: "hello BDODO 💮🌹🌺🌻🌼" }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  default:
                    break;
                }
                break;
              case DTACK: //"DTACK"
                switch (pcf) {
                  case 0:
                    ctx = { delta: 103, rwnd: 10, }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 1:
                    ctx = { delta: 103, rwnd: 10, una: tnseq + 10 }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 2:
                    ctx = { delta: 103, rwnd: 10, una: tnseq + 10, tnseqs: [tnseq, tnseq + 3, tnseq + 4] }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
                    break;
                  case 3:
                    ctx = { delta: 103, rwnd: 10, tnseqs: [tnseq, tnseq + 3, tnseq + 4] }
                    pack = new Package(mtype, pcf, cf, tn, seq, connid, ctx)
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

  exports.ConnectId = ConnectId;
  exports.SeqManage = SeqManage;
  exports.Header = Header;
  exports.Body = Body;
  exports.Package = Package;
  exports.BROAD = BROAD; // 发送广播数据包
  exports.MULTI = MULTI; // 发送多播数据包
  exports.WSASK = WSASK; // 窗口的大小询问
  exports.WSANS = WSANS; // 窗口的大小回复通知
  exports.PINGS = PINGS; // 验证与维持对端是否仍然存活
  exports.RESET = RESET; // 重置发送过程，可以是task级别，也可以是connection级别
  exports.CLOSE = CLOSE; // 关闭连接，最终释放所有的资源，正在传输的将继续，但不再处理其他的新任务

  exports.BEGIN = BEGIN; // 发送开始数据包
  exports.DOING = DOING; // 大型数据包中间数据包
  exports.DONED = DONED; // 结束数据包
  exports.BDODO = BDODO; // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
  exports.DTACK = DTACK; // 针对数据包的确认

  exports.VERSION = VERSION  // 版本号
  exports.PROTONAME = PROTONAME
  exports.MTU = MTU
  exports.MSS = MSS
  exports.SEP = SEP
  exports.getCurTimeStamp = getCurTimeStamp
});