/**
 * format：
 *         7      6      5      4      3      2      1      0   
 *     +------+------+------+------+------+------+------+------+
 *     | ack  |retain|retain|  qos |  dup |        type        |   头部（1byte）
 *     +------+------+------+------+------+------+------+------+
 *     |                 Sequence Number(4byte)                |   序列号（4byte）
 *     +------+------+------+------+------+------+------+------+
 *     |                    Checksum(2byte)                    |   校验和（2byte）
 *     +------+------+------+------+------+------+------+------+
 *     |       range   size        |           version         |   区段/版本号（1byte）
 *     +------+------+------+------+------+------+------+------+
 *     |                      data(nbyte)                      |   数据（nbyte）
 *     +------+------+------+------+------+------+------+------+
 * 
 * header：
 *   1 byte 0:
 *     0[0000 0000b]: "BROAD"  广播局域网内状态  <=>  128[1000 0000b]: "ABROAD"  确认同步
 *     1[0000 0001b]: "MULTI"  多播的传输数据包  <=>  129[1000 0001b]: "AMULTI"  确认定位
 *     2[0000 0010b]: "BEGIN"  首次开始数据传输  <=>  130[1000 0010b]: "ABEGIN"  确认开始
 *     3[0000 0011b]: "DOING"  中间数据传输过程  <=>  131[1000 0011b]: "ADOING"  确认数据
 *     4[0000 0100b]: "DONED"  结束数据传输过程  <=>  132[1000 0100b]: "ADONED"  确认结束
 *     5[0000 0101b]: "BDD"    整包数据传输过程  <=>  133[1000 0101b]: "ABDD"    确认整包
 * seq
 *   4 byte 1 ~ 4:
 *     sequence
 * checksum
 *   2 byte 5 ~ 6:
 *     crc16 checksum
 * data
 *   n byte 7 ~  wan MAX: 548-7 = 541 ~= 512 ; lan MAX: 1472-7 = 1465 ~= 1024
 * 
 */
(function (g, f) {
  const e = typeof exports == 'object' ? exports : typeof g == 'object' ? g : {};
  f(e);
  if (typeof define == 'function' && define.amd) {
    define('kudp', e);
  }
})(this, function (exports) {
  const utils = require('./common/utils')
  const cache = require('./common/cache')
  const BitSet = require('./common/BitSet.js')
  const event = require('./common/event.js')
  const seqTree = require('./common/tree').RBTree
  const task = require('./common/task')
  const timer = require('./common/timer')
  const heapify = require('./common/heapify')
  const Buffer = require('./common/Buffer/Buffer.js')

  const PROTONAME = 'kudp'
  const VERSION = 0x0 // kudp version

  const SEP = ':'
  const IDLEN = 5
  const IDMAX = Math.pow(10, IDLEN)
  const RIGHT_MOVE = 11
  const ISN_INTERVAL = 1 << RIGHT_MOVE  // 2048
  const MAX_SEQ = (-1 >>> 32) + 1
  const EXPIRE = 60000 // 60s
  const FACTOR = 4     // 默认放大因子
  const BASE_SECTION = 256 // 基础段长度
  const KUDP_SNDBUF = 4194304 // 4 * 124 * 1024 kb
  const KUDP_RCVBUF = 4194304 // 4 * 124 * 1024 kb

  // 重传机制超时时间
  const ACK_TIMEOUT = 400
  // 局域网最大数据包大小
  const LAN_PACK_SIZE = 1024
  // 广域网最大数据包大小
  const WAN_PACK_SIZE = 512
  // 重试次数
  const RETRY = 100
  // header leng
  const HEADER_LEN = 8


  // TODO: errcode
  const EKUDPOK = 0
  /** 1 ~ 20 udp相关过程中的错误 **/
  const EUDPSUPPORT = 1      // Can not support udp function 不支持udp的功能
  const EUDPCREATE = 2       // udp create error udp的create错误
  const EUDPBIND = 3         // udp bind error udp的bind错误
  /** 20 ~ 30 kudp发送过程中造成的异常 **/
  const EHEADERTYPE = 20     // 无效数据包header类型
  const ENOTALLOCISN = 23    // 无法分配到合适的isn
  const EALLOCISNERR = 24    // isn分配异常
  /** 30 ~ 40 kudp接收过程中造成的异常 **/
  const EBADFD = 77          // File descriptor in bad state 文件描述符状态错误
  /** 200 ~ 255 未知错误 **/
  const EUNKONWN = 255




  var LOG = {}
  LOG.level_ = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4
  }
  LOG.level = 'warn';
  LOG.func = function (funcName) {
    return function (msg) {
      if (LOG.level_[funcName] < LOG.level_[LOG.level]) { return; }
      if (console && console[funcName]) {
        console[funcName](msg);
      }
    };
  };
  LOG.warn = LOG.func('warn');
  LOG.debug = LOG.func('log');
  LOG.error = LOG.func('error');
  LOG.info = LOG.func('info');

  const Errors = (code, msg) => {
    return { code: code, msg: msg };
  }

  /**
   * 1. 一段时间内UDP传输过程中的seq资源的分配、消费管理；
   * 2. 一段时间内UDP传输过程中的数据包状态管理
   *     - 数据包控制位的设置与解析
   *     - 数据包数据传输状态的管理
   */
  class SeqManage {
    constructor(max) {
      /**
       * 表示已使用的isn的起始位，同时意味着该数字后2048个位置，被一定时间占用
       * eg: 
       *     isn = 152122
       *     则下一个数据包的isn
       *     必须从 152122 + 2048 = 154170开始分配
       */
      this.data = {}
      this.stat = new Stat();
      this.segment = [[0, (max || MAX_SEQ) + 1]];
    }

    /**
     * @param {number} size
     * @returns {number} isn  一个新的数据包发送，申请一个新的isn
     */
    malloc(size) {
      size = size || ISN_INTERVAL;
      let { isn, index } = this.getInitSeqNumber(size) || [-1, -1];
      if (isn > -1) {
        this.isn = isn;
        this.data[this.isn] = {};
        // 待确认的seq
        this.data[this.isn]['ack'] = [this.isn];
        // this.data[this.isn]['index'] = index;
        // seq区段大小
        this.data[this.isn]['length'] = size;
        // isn段的起始
        this.data[this.isn]['isn'] = this.isn
        // 最后一个seq的前一个，(左闭右开]
        this.data[this.isn]['last'] = this.isn + size;
        // 下一个可以使用的seq
        this.data[this.isn]['cursor'] = this.isn + 1;
      } else {
        throw Errors(ENOTALLOCISN, "malloc seq error");
      }
      return isn;
    }

    // 数组合并
    insert(dst, pos, src) {
      src.unshift(pos, 0);
      Array.prototype.splice.apply(dst, src);
      return dst;
    }

    /**
     * @param {number} size
     * @returns {object} 返回可以使用的isn
     */
    getInitSeqNumber(size) {
      let cnt = 0;
      let seq = null;
      let index = null;
      var segment = null;
      let len = this.segment.length
      // TODO：通过数据结构，优化算法效率
      while (cnt < len) {
        // TODO： 是否需要随机
        index = utils.RandomNum(0, len)
        // 不满足需要的size大小的段
        if (this.segment[index][1] - this.segment[index][0] < size) {
          cnt++;
        } else {
          segment = this.segment[index];
          break;
        }
      }
      // 遍历了所有的段，没有找到合适可以切割段，说明无法再次分配足够的空间
      if (cnt >= len && null == segment) {
        return { isn: -1, index: -1 };
      }
      let segment_tb = []
      seq = parseInt(utils.RandomNum(segment[0], segment[1] - size))
      if (segment[0] === seq) {
        segment_tb = [[segment[0] + size, segment[1]]]
      } else if (seq + size === segment[1]) {
        segment_tb = [[segment[0], segment[1] - size]]
      } else {
        segment_tb = [[segment[0], seq], [seq + size, segment[1]]
        ]
      }
      // 更新可用的区间段
      this.segment.splice(index, 1);
      this.segment = this.insert(this.segment, index, segment_tb);
      this.stat.set('sgcnt', this.segment.length);
      return { isn: seq, index: index };
    }

    /**
     * @param {number} isn a isn
     * 数据包确认完后，即时释放和清除
     */
    free(isn) {
      if (-1 === isn) {
        return
      }
      let index = 0;
      let isn_info = this.data[isn];
      // 针对单个seq的
      let start = isn_info['isn'] || isn;
      let last = isn_info['last'] || isn + 1;
      let len = this.segment.length;
      for (let i = 0; i < len; i++) {
        let segment = this.segment[i];
        if (segment[1] == start) {
          // merge 可用段
          segment[1] = last;
          index = i;
          break;
        }
      }
      for (let i = index; ; i++) {
        let cur = this.segment[i];
        let nxt = this.segment[i + 1];
        // 越界检测
        if (!nxt) { break; }
        if (cur[1] == nxt[0]) {
          cur[1] = nxt[1];
          this.segment.splice(index + 1, 1);
        }
      }
      this.stat.set('sgcnt', this.segment.length);
      delete this.data[isn]
    }

    /**
     * 获取下一个可用的seq
     * @param {number} isn will return a seq from a isn
     * @param {boolean} loop true loop use seq number, false not loop
     * @returns {boolean} seq a next seq can be use 
     */
    get(isn) {
      // 返回可用的最新的seq，然后自增
      if (isn > -1 && this.data[isn]['cursor']) {
        let seq = isn + ((this.data[isn]['cursor']++) - isn) % this.data[isn]['length'];
        // 写入一个待确认的seq
        this.data[isn]['ack'].push(seq)
        return seq
      }
      return -1;
    }

    /**
     * 从一个isn, 删除已确认的数据包seq 
     * @param {number} seq 待删除的业务层确认的序号
     */
    del(seq, isn) {
      let _isn = isn || this.location(seq);
      let isn_info = this.data[_isn] || { ack: [] }
      if (isn_info['length']) {
        let index = isn_info['ack'].indexOf(seq);
        if (index >= 0) {
          this.data[_isn]['ack'].splice(index, 1);
        }
      } else {
        this.free(seq);
      }
    }

    /**
     * @param {number} isn
     * @returns {object} 获取一个isn的所有待确认的seq
     */
    ack(isn) {
      return this.data[isn]['ack']
    }

    /**
     * @param {number} seq a seq number
     * @returns {object} 获取定位一个seq属于哪个isn段内
     */
    location(seq) {
      let isn = -1;

      function bs(arr, key) {
        var low = 0, high = arr.length - 1;
        while (low <= high) {
          let mid = parseInt(low + (high - low) / 2);
          if (key == arr[mid][0]) {
            return mid;
          } else if (key > arr[mid][0]) {
            low = mid + 1;
          } else if (key < arr[mid][0]) {
            high = mid - 1;
          }
        }
        return high;
      };
      let pos = bs(this.segment, seq);
      isn = (seq >= this.segment[pos][1]) ? this.segment[pos][1] : -1;
      return isn;
    }

    /**
     * @param {number} seq a seq number
     * @returns {number} 检测一个seq是否被确认 -1 invalid, 0 no checked, 1 checked
     */
    check(seq) {
      let isn = this.location(seq);
      return (isn < 0) ? -1 :     // 不存在对应的isn
        (
          this.data[isn]['ack'].indexOf(seq) >= 0
            ? 0                   // 存在待确认ack队列内，说明未确认
            : 1                   // 已确认
        )
    }

    /**
     * @param {number} isn
     * @returns {object} 获取isn对应的所有信息
     */
    info(isn) {
      return this.data[isn];
    }

    /**
     * 清空并释放所有
     */
    clear() {
      this.data = {}
      this.stat = null;
      this.segment = [];
    }

    /**
     * 测试函数
     */
    static testSeqManage() {
      let seqm = new SeqManage(100000);
      let isn = 0;
      var i = 0;
      while (isn != -1 && ++i < 1000) {
        let size = utils.RandomNum(1, 104)
        isn = seqm.malloc(size);
        LOG.debug(seqm.info(isn));
        if (i % 50) {
          seqm.free(isn)
        } else {
          let seq = isn + utils.RandomNum(0, size);
          let losin = seqm.location(seq);
          LOG.debug(i, "seq:", seq, " location:", losin, " isn:", isn);
        }
      }
      seqm.clear();
    }
  }

  /**
   * stat some info
   */
  class Stat {
    constructor() {
      this.props = {}
    }
    incr(key, v) {
      return this.props[key] ? this.props[key] += (v || 1) : this.props[key] = (v || 1);
    }
    decr(key) {
      return this.props[key] ? this.props[key]-- : this.props[key] = 0;
    }
    set(key, val) {
      return this.props[key] ? this.props[key] = val || 0 : this.props[key] = val || 0;
    }
    del(key) {
      delete this.props[key];
    }
    get(key) {
      return this.props[key];
    }
    avg(key, val) {
      if (!this.props[key]) {
        this.props[key] = 0;
        this.props[key + "_cnt"] = 1;
        this.props[key] += ((val || 0) - this.props[key]) / this.props[key + "_cnt"];
      } else {
        this.props[key] += ((val || 0) - this.props[key]) / ++this.props[key + "_cnt"];
        this.props[key] = parseFloat(this.props[key].toFixed(2));
      }
    }
  }

  var BROADWAY = "255.255.255.255"
  const FD_BROAD = 3 // 广播占用fd
  const FD_MULTI = 4 // 多播占用fd
  // 数据包类型
  const BROAD = 0x0  // 广播数据包
  const MULTI = 0x1  // 多播数据包
  const BEGIN = 0x2  // 首个数据包
  const DOING = 0x3  // 大型数据包中间数据包
  const DONED = 0x4  // 结束数据包
  const BDD = 0x5    // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包

  // 确认数据包
  const ABROAD = 0x80 | BROAD  // 广播数据包
  const AMULTI = 0x80 | MULTI  // 多播数据包
  const ABEGIN = 0x80 | BEGIN  // 首个数据包
  const ADOING = 0x80 | DOING  // 大型数据包中间数据包
  const ADONED = 0x80 | DONED  // 结束数据包
  const ABDD = 0x80 | BDD      // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包

  // header反消息类型
  const rHeaderType = {
    "BROAD": BROAD,
    "MULTI": MULTI,
    "BEGIN": BEGIN,
    "DOING": DOING,
    "DONED": DONED,
    "BDD": BDD,
    "ABROAD": ABROAD,
    "AMULTI": AMULTI,
    "ABEGIN": ABEGIN,
    "ADOING": ADOING,
    "ADONED": ADONED,
    "ABDD": ABDD,
  }

  // header消息类型
  const HeaderType = {
    // 发送数据包类型
    [BROAD]: "BROAD",
    [MULTI]: "MULTI",
    [BEGIN]: "BEGIN",
    [DOING]: "DOING",
    [DONED]: "DONED",
    [BDD]: "BDD",
    // 确认数据包类型
    [ABROAD]: "ABROAD",
    [AMULTI]: "AMULTI",
    [ABEGIN]: "ABEGIN",
    [ADOING]: "ADOING",
    [ADONED]: "ADONED",
    [ABDD]: "ABDD"
  }

  /**
   * 数据包头解析
   */
  class Header {
    constructor(type, dup, qos, ack) {
      this.bits = 0
      if (!this.invalidType(type)) {
        throw Errors(EHEADERTYPE, "invalid type", type);
      }
      this.setType(type);
      (dup === 1) ? this.setDup(dup) : null;
      (qos === 1) ? this.setQos(qos) : null;
      (ack === 1) ? this.setAck(ack) : null;
    }
    // 检测有效的类型
    invalidType(mtype) {
      return HeaderType[mtype]
    }
    // 设置mtype的每一个bit
    addType(flag) {
      return this.bits |= flag
    }
    // 设置mtype的每一个bit
    setType(flag) {
      this.bits &= 0xfc;
      return this.bits |= flag
    }
    // 设置dup位(4)
    setDup(flag) {
      return (1 === flag) ? this.bits |= 0x08 : ((0 === flag) ? this.bits &= 0xf7 : this.bits);
    }
    // 设置qos位(5)
    setQos(flag) {
      return (1 === flag) ? this.bits |= 0x10 : ((0 === flag) ? this.bits &= 0xef : this.bits);
    }
    // 设置ack位(7)
    setAck(flag) {
      return (1 === flag) ? this.bits |= 0x80 : ((0 === flag) ? this.bits &= 0x7f : this.bits);
    }
    // 从数据反构造一个header
    static New(bits) {
      let type = (bits & 0x7) | (bits & 0x80)
      if (!HeaderType[type]) {
        throw Errors(EHEADERTYPE, "invalid type new", bits);
      }
      let dup = (bits & 0x08) >>> 3;
      let qos = (bits & 0x10) >>> 4;
      return new Header(type, dup, qos);
    }

    // header属性
    Type() {
      return (this.bits & 0x7) | (this.bits & 0x80);
    }
    Dup() {
      return (this.bits & 0x08) >>> 3;
    }
    Qos() {
      return (this.bits & 0x10) >>> 4;
    }
    Ack() {
      return (this.bits & 0x80) >>> 7;
    }
    IsFin() {
      return (BDD === this.Type() || DONED === this.Type())
    }
    // 获取header信息
    info() {
      return {
        type: this.Type(), // type
        dup: this.Dup(),   // dup
        qos: this.Qos(),   // qos
        ack: this.Ack(),   // ack
        str: this.bits.toString(2),
        desc: HeaderType[this.Type()],
      }
    }
    header() {
      return this.bits;
    }

    // 测试
    static testHeader() {
      // type test
      let heads = []
      for (let key in rHeadeType) {
        let head1 = new Header(rHeadeType[key]);
        heads.push(head1.header());
        LOG.debug("type Tesing info:", head1.info());
        LOG.debug("type Tesing data:", head1.header());
        LOG.debug("type Tesing Type:", head1.Type());
        LOG.debug("type Tesing Qos:", head1.Qos());
        LOG.debug("type Tesing Dup:", head1.Dup());
        LOG.debug("type Tesing Ack:", head1.Ack());
      }
      // Dup test
      for (let key in rHeadeType) {
        let head1 = new Header(rHeadeType[key], 1);
        heads.push(head1.header());
        LOG.debug("dup Tesing info:", head1.info());
        LOG.debug("dup Tesing data:", head1.header());
        LOG.debug("dup Tesing Type:", head1.Type());
        LOG.debug("dup Tesing Qos:", head1.Qos());
        LOG.debug("dup Tesing Dup:", head1.Dup());
        LOG.debug("dup Tesing Ack:", head1.Ack());
      }
      // Qos test
      for (let key in rHeadeType) {
        let head1 = new Header(rHeadeType[key], 0, 1);
        heads.push(head1.header());
        LOG.debug("qos Tesing info:", head1.info());
        LOG.debug("qos Tesing data:", head1.header());
        LOG.debug("qos Tesing Type:", head1.Type());
        LOG.debug("qos Tesing Qos:", head1.Qos());
        LOG.debug("qos Tesing Dup:", head1.Dup());
        LOG.debug("qos Tesing Ack:", head1.Ack());
      }
      // All test
      for (let key in rHeadeType) {
        let head1 = new Header(rHeadeType[key], 1, 1);
        heads.push(head1.header());
        LOG.debug("all Tesing info:", head1.info());
        LOG.debug("all Tesing data:", head1.header());
        LOG.debug("all Tesing Type:", head1.Type());
        LOG.debug("all Tesing Qos:", head1.Qos());
        LOG.debug("all Tesing Dup:", head1.Dup());
        LOG.debug("all Tesing Ack:", head1.Ack());
      }
      // test New
      for (let i in heads) {
        let header = Header.New(heads[i])
        LOG.debug("Tesing new info:", header.info());
      }
    }
  }

  /**
   * package 解析器
   */
  class Package {
    constructor(type, dup, qos, ack, pkg) {
      this.header = null;
      this.buffer = null;
      if ("Number" === utils.Type(type)) {
        this.header = new Header(type, dup, qos, ack);
      }
      if (pkg && "Object" === utils.Type(pkg)) {
        this.seq = pkg.seq;
        this.payload = pkg.payload || "";
        this.factor = pkg.factor || FACTOR;
        this.build(this.header, this.seq, this.payload, this.factor);
      }
    }

    // 构建pack
    build(header, seq, payload, factor) {
      let [msg, checksum] = Package.pack(header, seq, payload, factor);
      this.buffer = msg.buffer
      this.checksum = checksum
    }

    // 设置header的标志位
    setFlags(dup, qos, ack) {
      let s0 = (dup !== this.header.Dup()) ? this.header.setDup(dup) : null;
      let s1 = (qos !== this.header.Qos()) ? this.header.setQos(qos) : null;
      let s2 = (ack !== this.header.Ack()) ? this.header.setAck(ack) : null;
      if (s0 || s1 || s2) {
        this.build(this.header, this.seq, this.payload);
      }
    }

    // 编码数据包结构
    static pack(header, seq, payload, factor) {
      let psize = Buffer.byteLength(payload, 'utf8')
      // let msg = new Buffer(psize + HEADER_LEN);
      // /** 写入header数据 */
      // msg.writeUInt8(header.header());  // 0
      // msg.writeUInt32BE(seq, 1);        // 1 ~ 4
      // msg.writeUInt16BE(0x0, 5);        // 5 ~ 6
      // if (BEGIN === header.Type()) {
      //   // 消息区段
      //   let rangesize = factor || FACTOR;
      //   let lastlen = (rangesize << 4) | VERSION;
      //   msg.writeUInt8(lastlen, 7);     // 7 消息区段 + version
      // } else if (BDD === header.Type()) {
      //   // 消息区段
      //   let rangesize = 0
      //   let lastlen = (rangesize << 4) | VERSION;
      //   msg.writeUInt8(lastlen, 7);     // 7 消息区段 + version
      // }
      // /** 写入数据包内容 */
      // msg.write(payload, HEADER_LEN)    // 8 消息内容
      // let checksum = utils.Crc16(msg);
      // msg.writeUInt16BE(checksum, 5);   // 5 ~ 6 消息checksum 2byte
      // LOG.debug("pack compare1:", msg)

      let msg2 = new Buffer(psize + HEADER_LEN);
      /** 写入header数据 */
      msg2.writeUInt8(header.header());    // 0
      msg2.writeUInt32BE(seq);             // 1 ~ 4
      msg2.writeUInt16BE(0x0);             // 5 ~ 6
      if (BEGIN === header.Type()) {
        // 消息区段
        let rangesize = factor || FACTOR;
        let lastlen = (rangesize << 4) | VERSION;
        msg2.writeUInt8(lastlen);          // 7 消息区段 + version
      } else if (BDD === header.Type()) {
        // 消息区段
        let rangesize = 0
        let lastlen = (rangesize << 4) | VERSION;
        msg2.writeUInt8(lastlen);          // 7 消息区段 + version
      } else {
        msg2.writeUInt8(0);                // 7 消息区段 + version
      }
      /** 写入数据包内容 */
      msg2.write(payload)                  // 8 消息内容
      let checksum2 = utils.Crc16(msg2);
      msg2.writeUInt16BE(checksum2, 5);    // 5 ~ 6 消息checksum 2byte
      // LOG.debug("pack compare2:", msg2, msg2.toString() == msg.toString())
      return [msg2, checksum2];
    }

    // 解码数据包
    static unpack(buffer) {
      let pkg = new Package();
      let msg = new Buffer(buffer)
      /** 从buffer 读出header */
      pkg.buffer = msg.buffer
      pkg.header = Header.New(msg.readUInt8()); // 0
      pkg.seq = msg.readUInt32BE(1);            // 1 ~ 4
      pkg.checksum = msg.readUInt16BE(5);       // 5 ~ 6 消息checksum 2byte
      if (BEGIN === pkg.header.Type()) {
        let lastlen = msg.readUInt8(7);         // 7 消息区段 + version 
        // 消息区段
        pkg.rangesize = (lastlen >> 4) * BASE_SECTION;
        // kudp version
        pkg.version = lastlen & 0x0f;
      } else if (BDD === pkg.header.Type()) {
        let lastlen = msg.readUInt8(7);          // 7 消息区段 + version 
        // 消息区段
        pkg.rangesize = (lastlen >> 4) * BASE_SECTION;
        // kudp version
        pkg.version = lastlen & 0x0f;
      }
      /** 从buffer 读出消息内容 */
      pkg.payload = msg.read(HEADER_LEN);         // 8 消息内容
      pkg.payloadbuffer = msg.slice(HEADER_LEN)
      msg.writeUInt16BE(0, 5);                    // 5 ~ 6 消息checksum 2byte
      let checksum = utils.Crc16(msg);
      // LOG.debug("unpack", msg, pkg)
      return (checksum == pkg.checksum) ? pkg : null;
    }
  }

  /**
   * create a new fd while open a new connect
   */
  class Fd {
    constructor(size) {
      // 初始化一个默认1024比特的bitset,其中0、1、2、3、4被默认占用
      this.fdset = new BitSet("31,0," + (size || 1024));
      // 每个bit位的附加信息
      this.fdinfo = {};
      this.init();
    }
    // 初始化几个固定的bit位的信息
    init() {
      this.setBit(FD_BROAD, {
        fd: FD_BROAD,
        flag: BROAD,
        time: utils.GetTimestamp(),
      });
      this.setBit(FD_MULTI, {
        fd: FD_MULTI,
        flag: MULTI,
        time: utils.GetTimestamp(),
      });
    }
    // 获取一个合适fd，同时绑定相关信息
    setInfo(info) {
      let fd = this.getfd();
      info.fd = fd;
      this.setBit(fd, info);
      return fd;
    }
    // 为一个已经设置过数据的fd添加属性。
    addInfo(fd, info) {
      this.fdinfo[fd] = Object.assign((this.fdinfo[fd] || {}), info)
    }
    // 获取最小一个0的位置作为下一个可分配的fd
    getfd() {
      let fd = this.fdset.ffz();
      if (fd < 0) {
        throw Errors(EBADFD, "bad fd");
      }
      this.fdset.set(fd);
      return fd
    }
    // 设置bit附属信息
    setBit(fd, info) {
      this.fdinfo[fd] = info;
    }
    // 释放一个fd，同时挥手bit
    close(fd) {
      this.fdset.unset(fd);
      delete this.fdinfo[fd];
    }
    // 获取bit对应的附属属性
    getInfo(fd) {
      return this.fdinfo[fd];
    }
    static testFd() {
      var fdset = new Fd("0,99");
      let i = 0
      while (i++ < 1000) {
        fdset.setInfo({ [i]: i });
      }
      i = fdset.fdset.ffz();
      while (i-- >= 0) {
        fdset.close(i);
      }
    }
  }

  class UdpBase {
    constructor(port) {
      this.create(port);
    }
    create(port) {
      if (typeof wx.createUDPSocket !== 'function') {
        throw Errors(EUDPSUPPORT, "udp socket is not support!!!");
      }
      try {
        this.kudper = wx.createUDPSocket();
        if (this.kudper) {
          this.kudper.bind(port);
        } else {
          throw Errors(EUDPBIND, "udp bind socket error!!!");
        }
      } catch (e) {
        console.error("createUDPSocket:", e);
        throw Errors(EUDPCREATE, "create udp socket error!!!");
      }
    }
    onClose() {
      return new Promise((resolver) => {
        this.kudper.onClose(function (res) {
          LOG.info("onClose: ", res);
          resolver({
            message: utils.NewAb2Str(res.message),
            IPinfo: res.remoteInfo,
          });
        });
      });
    }
    offClose() {
      return new Promise((resolver) => {
        this.kudper.offClose(function (res) {
          LOG.info("offClose: ", res);
          resolver({
            message: utils.NewAb2Str(res.message),
            IPinfo: res.remoteInfo,
          });
        });
      });
    }
    onError() {
      return new Promise((resolver) => {
        this.kudper.onError(function (res) {
          LOG.error("onError: ", res);
          resolver({
            message: utils.NewAb2Str(res.message),
            IPinfo: res.remoteInfo,
          });
        });
      });
    }
    offError() {
      return new Promise((resolver) => {
        this.kudper.offError(function (res) {
          LOG.error("offError: ", res);
          resolver({
            message: utils.NewAb2Str(res.message),
            IPinfo: res.remoteInfo,
          });
        });
      });
    }
    onListening() {
      return new Promise((resolver) => {
        this.kudper.onListening(function (res) {
          resolver({
            message: utils.NewAb2Str(res.message),
            IPinfo: res.remoteInfo,
          });
        });
      });
    }
    offListening() {
      let self = this;
      return new Promise((resolver) => {
        this.kudper.offListening(function (res) {
          self.onError();
          self.offError();
          resolver({
            message: utils.NewAb2Str(res.message),
            IPinfo: res.remoteInfo,
          });
        });
      });
    }
    offMessage() {
      return new Promise(() => {
        this.kudper.offMessage(function () { });
      });
    }
    onMessage() {
      let self = this;
      self.kudper.onMessage(function (res) {
        self._onMessageHandler(res);
      });
    }
    send(ip, port, msg) {
      return this.kudper.send({ address: ip, port: port, message: msg });
    }
  }

  /**
   * 接收器：
   * 接收到数据包后，做上报业务层管理器
   * 在一次单向的发送 <--> 接收 的过程中
   *  发送方：仅仅只会接收  ABROAD ~ ABDD
   *  接收方：仅仅只会接收  BROAD ~ BDD
   * 对于接收器来说，只会处理接收到的数据包，并对接收到的数据包做一些相应的处理
   *
   * 概念:
   * - 数据块级别：表示一次独立的完整传输过程，比如一张图片，一段文本，一个视频，由被分离的数据包组装而成，必须包含 BEGIN -> DOING -> DONED / BDD 的数据包类型
   * - 接收器级别：一个完整的接收器等级，接收器可以同时接受多个不同的独立数据块传输（数据块级别），比如一段文字、一张图片 可以同时传输
   *
   * 关键成员功能作用:
   *
   * - timers: 接收器级别，用来记录每一个数据包的超时时的释放工作，已经重复时的定时器重置工作，避免重复接收时鉴别
   * - staging: 接收器级别，用来记录所有没有收到 BEGIN 数据包的数据包，暂存起来等待首个数据包，TODO：是一个恶意攻击点
   * - onUp: 数据块级别，用来数据包接收器处理已经就绪的数据包时的上报回调，TODO：怎么分离出不同的数据块
   * - onEcho: 数据块级别，在接收到数据包后，需要做出的响应动作，比如向发送发恢复ACK，TODO：同上
   * - onTick: 数据块级别，在接收到数据包时的回调，主要用来方便统计，TODO：同上
   * - onAck: 数据块级别，在接收到ACK类型的数据包时的回调，TODO：同上
   * - onDone: 数据块级别，数据包接收完成回调，TODO：同上
   * - queue：接收器级别，管理所有的数据块的接收队列
   *   - seq 一次数据块传输的首个序号
   *   - peer 是发送端信息
   *   - M 数据包最大序号 Max
   *   - L 数据包理论最大序号, 超过将回滚循环使用 last
   *   - P 待上报的最小seq, pointer
   *   - Q 数据块级别，记录已经收到的数据，按seq的优先队列，该队列（优先队列PQ）是处理本数据块的所有seq，注意与 queue 的区别
   *   - T 数据包类型 type
   *   - V 协议版本 version
   *   - _ 当前节点所在的queue指针，方便操作该指针的数据，比如修改该节点的传输状态
   */
  class Recver {
    static UPCD_SIZE = 5;  // 触发上报数据包的最小限制
    static prefix = PROTONAME + SEP + VERSION + SEP + 'recver' + SEP;
    constructor(options) {
      this.timers = {};
      this.staging = {};
      for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
      this.queue = new seqTree(Recver.prefix, (a, b) => a.seq - b.seq); // 并发传输多个数据块的处理队列
      this.initOptions(options);
    }

    defaultOptions = {
      onUp: () => { LOG.info("onUp callback: ", arguments) },                 // 上报上层回调
      onEcho: () => {        /*LOG.info("onEcho callback: ", arguments);*/ }, // 接收到消息后，回复ack
      onAck: () => { LOG.info("onAck callback: ", arguments); },              // 接收到Ack类型数据包回调
      onDone: () => { LOG.info("onDone callback: ", arguments); },            // 数据包接收完成回调
      onTick: null,
    }

    // 初始化cb options
    initOptions(option, value) {
      if (option && value) this[option] = value
      if (!value && typeof option === 'object') {
        for (var prop in option) {
          if (this.defaultOptions.hasOwnProperty(prop) && this.hasOwnProperty(prop))
            this[prop] = option[prop]
        }
      }
      return this
    }

    // 接收到数据
    onMessage(res) {
      let { mtype, seq, peerInfo, payload, rangesize, version, payloadbuffer } = this.decode(res.remoteInfo, res.message);
      if (mtype < ABROAD) {
        this.push(mtype, seq, peerInfo, payload, rangesize, version);
      } else {
        this.shift(mtype, seq, peerInfo, payload);
      }
      (typeof this.onTick === "function") && this.onTick(mtype, 0);
    }

    // 接收方：处理来自网络的数据包 推送一个接收到的数据到接收队列，
    push(mtype, seq, peerInfo, payload, rangesize, version) {
      // 发送ack数据包
      LOG.info("Push seq:", seq, payload);
      this.onEcho(peerInfo.address, peerInfo.port, mtype, seq);
      let data = { seq: seq, message: payload, IPinfo: peerInfo, iPint: peerInfo.ipint, };
      switch (mtype) {
        case DOING:
          data.type = 'DOING';
          this.stage(mtype, seq, peerInfo, payload);
          break;
        case BEGIN:
          data.type = 'BEGIN';
          this.begin(seq, peerInfo, payload, rangesize, version);
          break;
        case BDD:
          data.type = 'BDD';
          this.bdd(seq, peerInfo, payload, rangesize, version);
          break;
        case DONED:
          data.type = 'DONED';
          this.stage(mtype, seq, peerInfo, payload);
          break;
        case BROAD:
          data.type = 'BROAD';
          this.onUp(seq, mtype, seq, peerInfo, payload);
          break;
        case MULTI:
          data.type = 'MULTI';
          this.onUp(seq, mtype, seq, peerInfo, payload);
          break;
        default:
          break;
      }
      // 添加seq定时器
      this.addSeqTimer(seq);
    }

    // 发送方：处理来自网络的确认包 接收到ack数据包处理
    shift(mtype, seq, peerInfo, payload) {
      let data = { seq: seq, message: payload, IPinfo: peerInfo, iPint: peerInfo.ipint, };
      // 针对数据包不同类型特殊处理
      switch (mtype) {
        case ABROAD:
          break;
        case AMULTI:
          break;
        case ABEGIN:
          break;
        case ADOING:
          break;
        case ADONED:
          break;
        case ABDD:
          break;
        default:
          break;
      }
      this.onAck(mtype, seq, peerInfo, payload)
    }

    /**
     * 定位一个seq 在 queue中的在 BEGIN 时创建的元数据信息，若不存在返回 null
     * @param {*} seq
     * TODO 序号比较器, 由于比较器与插入时不一样，可能导致查询效率问题
     */
    location(seq) {
      return this.queue.find({ seq: seq }, (data, ori) => {
        if (ori.seq <= data.seq && ori.L > data.seq) {
          return 0;
        } else if (ori.seq > data.seq) {
          return -1
        } else if (ori.L <= data.seq) {
          return 1;
        }
        return -1;
      });
    }

    // 处理 BEGIN 数据包时，需要检测是否存在预先到达的本数据块的 DOING / DONED 包
    begin(isn, peerInfo, payload, rangesize, version) {
      let node = {
        seq: isn,                  // node.seq 是isn
        peer: peerInfo,            // node.peer 是发送端信息
        L: isn + rangesize,        // node.L 理论数据包最大序号
        M: isn + rangesize,        // node.M 数据包最大序号
        P: isn,                    // node.P 待上报的最小seq
        Q: new heapify(rangesize), // node.Q 记录已经收到的数据，按seq的PQ
        T: BEGIN,
        V: version,                // node.T node.V 数据包类型及协议版本
        BF: Buffer.alloc(KUDP_RCVBUF),
      }
      // other 标记该queue的节点是否已经被操作完成，此处表示该节点对应的数据块是否已经接收完
      let curnode = this.queue.insert(node, { done: 0, stat: 0 });
      if (curnode && 1 === curnode.other.done) {
        curnode.other.stat++;
        LOG.warn("begin Repeat:", isn)
        return;
      }
      node._ = curnode;
      // 用优先队列实现接收的数据包排序
      this.addSeqQueue(node, isn, payload);
      // 检测所有暂存区中已有的seq
      for (var seq in this.staging) {
        let seq_data = this.staging[seq];
        let mtype = seq_data[0];
        let seq1 = seq_data[1];
        let peer2 = seq_data[2];
        let payload3 = seq_data[3];
        // 记录最大seq
        if (DONED === mtype)
          curnode.data['M'] = seq1;
        if (peer2.address === peerInfo.address && peer2.port === peerInfo.port &&  // 必须是同一个ip:port
          seq1 >= node.seq && seq1 < node.L) {
          this.addSeqQueue(node, seq1, payload3);
          delete this.staging[seq1];
        }
      }
      this.checkQ(node);
    }

    // 处理 BDD 数据，直接上报
    bdd(isn, peerInfo, payload, rangesize, version) {
      this.queue.insert({ seq: isn, peer: peerInfo, L: isn + rangesize, Q: [{ [isn]: payload }], T: BDD, V: version })
      this.onUp(isn, BDD, isn, peerInfo, payload);
    }

    /**
     * 检测数据队列中的内容是否可以上报
     * 触发可能上报的时机:
     *   1. Q中累积的数据包超过 UPCD_SIZE
     *   2. M - P <=  UPCD_SIZE, 即 数据快接收到尾声
     *
     * 如下示意图：
     *    P   ->     ->     ->     ->     ->     -> P M
     *  |------|------|------|------|------|------|----
     *  o      ^      ^      ^      ^      ^      ^   e
     *
     * 其中 除了 0, 中间的 ^ 表示提交点，中间间隔表示 UPCD_SIZE
     * - 每一次 ^ 表示需要提交， 即触发 条件 1
     * - 但是到最后的情况 e 不满足 UPCD_SIZE 的大小，但必须提交 触发条件2
     *   - 明显，L - P < UPCD_SIZE
     * 关于提交的数据什么时候停止：
     *   - 提交所有目前连续的seq，知道最后一个不连续的或队列为空为止。暂不考虑过多的情况（TODO）
     */
    checkQ(node) {
      // 如果已经接收结束，不应该再走入下面的流程中
      if (1 === node['_'].other.done) {
        LOG.error("queue isn: ", node['seq'], ' is done!')
        return;
      }
      let Q = node['Q'];
      let delta = node['M'] - node['P'];
      if (Q && (Q.size >= Recver.UPCD_SIZE || delta < Recver.UPCD_SIZE)) {
        let i = 0;
        // TODO, 数据组装
        let payloads = null;
        while (i++ <= Q.capacity || 0 !== Q.size) {
          let priority = Q.peekPriority(); // 即为 seq
          if (priority !== node['P'])
            break;
          // 检测seqTimer是否已经timeout, 如果已经过期，说明在规定的时间内，没有重复seq
          this.freeSeq({ seq: priority })
          // TODO：回收已经上报的seq，时机是否合适？
          let pld = Q.pop();
          this.checkRcvBuf(node, pld);
          payloads = (null === payloads) ? new Buffer(pld) : Buffer.concat([payloads, new Buffer(pld)]);
        }
        // payloads && node['BF'].write(payloads.buffer);
        // payloads && this.onUp(node['seq'], node['T'], node['P'], node['peer'], payloads);
        // payloads && LOG.debug("checkQ:", payloads.toString())
      }
      // 表示数据包已经接受完毕, 设置定时器释放可能没有释放queue
      if (this.isOver(node)) {
        node['_'].other.done = 1; // 当前数据块，接收数据已经
        this.onDone(node['seq'], node['peer']);
        /**
         * TODO：释放接收器queue的时机
         * 1. 过早的释放导致重复的seq无法处理
         * 2. 太晚的释放导致过多的无效节点结构
         */
        // new timer({
        //   onend: (args) => {
        //     let seq = (args || {}).seq;
        //     this.queue.remove({ seq: seq });
        //   }
        // }, { seq: node['seq'] }).start(ACK_TIMEOUT * 10);
      }
    }

    checkRcvBuf(node, deltaData) {
      let len = deltaData.length
      let offset = node['BF']._woffset
      let max = node['BF'].length
      if (len + offset < max) {
        let a = node['BF']._woffset
        node['BF'].write(deltaData);
        node['P']++;
        LOG.info("checkRcvBuf", a, node['p'])
        if (this.isOver(node)) {
          LOG.info("checkRcvBuf", a, node['BF']._woffset, node['BF'].slice(0, node['BF']._woffset).toString())
          this.onUp(node['seq'], node['T'], node['P'], node['peer'], node['BF'].slice(0, node['BF']._woffset).toString());
        }
      } else if (len + offset >= max) {
        this.onUp(node['seq'], node['T'], node['P'], node['peer'], node['BF'].toString());
        node['BF'].flush();
        node['BF'].write(deltaData);
        node['P']++;
      } else {

      }
      return false;
    }

    isOver(node) {
      return node['M'] <= node['P'];
    }

    /**
     * 暂存区处理
     * 1. 提前到达的DOING/DONED 暂存
     * 2. 重复到达的DOING/DONED 丢弃
     * TODO：内存问题
     */
    stage(mtype, seq, peerInfo, payload) {
      let seqTimer = this.timers[Recver.prefix + seq]
      if (!seqTimer) {
        let curnode = this.location(seq);
        if (curnode) {
          // 接收到的数据seq，小于下一个需要的seq，表明重试数据seq
          if (curnode.data) {
            // 记录最大seq
            if (DONED === mtype)
              curnode.data['M'] = +seq + 1;
            if (curnode.data['P'] > seq) {
              curnode.other.stat++;
            } else {
              this.addSeqQueue(curnode.data, seq, payload);
              this.checkQ(curnode.data);
            }
          }
        } else {
          // 未找到BEGIN的数据包
          this.staging[seq] = [mtype, seq, peerInfo, payload];
        }
      }
    }

    // 添加收到seq 到 Q
    addSeqQueue(node, seq, payload) {
      if (seq >= node['P']) {
        node['Q'].push(payload, seq);
      } else {
        LOG.warn("addSeqQueue Repeat:", seq)
      }
    }

    /**
     * 原则：尽可能的保证对方收到ACK。
     * 1. 在2 * ACK_TIMEOUT，仍然没有收到对方的重复数据包，即可认为对方已经收到对应的seq的ack，即可释放对应seq
     * 2. 如果重新收到同一seq的数据包，说明对方没有收到ACK，此时需要重新启动同一个定时器，避免seq被释放
     */
    addSeqTimer(seq) {
      let seqTimer = this.timers[Recver.prefix + seq]
      if (!seqTimer) {
        seqTimer = new timer({
          onrestart: (...args) => { LOG.warn(args, 'timer restart') },
          onend: (args) => { this.freeSeq(args); }
        }, { seq: seq });
        // 记录下每个数据包的定时器，在必要的时候重置定时器
        this.timers[Recver.prefix + seq] = seqTimer;
        seqTimer.start(ACK_TIMEOUT * 2);
      } else {
        seqTimer.restart(ACK_TIMEOUT * 2);
      }
    }

    // 释放接收队列中的已经确认的seq
    freeSeq(args) {
      let seq = (args || {}).seq;
      let seqTimer = this.timers[Recver.prefix + seq];
      if (!seqTimer) return false;

      if (1 === (seqTimer.args || {}).timeout) {
        delete this.timers[Recver.prefix + seq];
        return;
      }
      // 从queue中定位对应的isn
      let curnode = this.location(seq);
      if (curnode) {
        // 删除定时器
        delete this.timers[Recver.prefix + seq];
      } else {
        seqTimer.setArgs({ timeout: 1 });
      }
    }

    // 解析从外界收到的数据包
    decode(peer, buffer) {
      let pkg = Package.unpack(buffer);
      let mtype = pkg.header.Type(),
        seq = pkg.seq;
      peer.ipint = utils.Ip2Int(peer.address); // ip对应的数字
      return {
        mtype: mtype, seq: seq, peerInfo: (peer || {}), payload: pkg.payload,
        rangesize: pkg.rangesize, version: pkg.version, payloadbuffer: pkg.payloadbuffer
      }
    }

    // unserialize the data
    unserialize(data) {
      return JSON.parse(data)
    }

    // Test
    static testRecver() {
      let rQueue = new Recver();
      let concurrency = 1; // 支持同时发送数据内容个数
      let peerInfo = { address: "127.0.0.1", port: 5328 };
      // 新建一个测试任务表
      const t = new task(concurrency, () => {
        // LOG.warn(rQueue, 'All task done!');
      });

      // 测试任务函数, 模拟 BEGIN/DOING/DONED 数据包
      function Task(isn, seq_list, peerInfo, rangesize) {
        if (0 === seq_list.length)
          return;
        let seq = seq_list.shift();
        // 通过seq 鉴别是什么类型的数据包
        let mtype = null;
        if (1 === rangesize) {
          mtype = BDD;
        } else {
          if (seq === isn) {
            mtype = BEGIN;
          } else if (seq < isn + rangesize - 1) {
            mtype = DOING
          } else {
            mtype = DONED;
          }
        }
        let payload = "Testing" + SEP + HeaderType[mtype] + SEP + seq;
        let pkg = { seq: seq, size: payload.length, type: mtype, payload: payload, factor: rangesize }
        let pack = new Package(mtype, 0, 0, 0, pkg);
        rQueue.onMessage({ remoteInfo: peerInfo, message: pack.buffer });

        switch (mtype) {
          case BDD:
            LOG.warn("Tested" + SEP + HeaderType[mtype] + SEP + seq);
            return;
          case BEGIN:
          case DOING:
          case DONED:
            t.addTask(utils.RandomNum(0, ACK_TIMEOUT / 2), Task, isn, seq_list, peerInfo, rangesize);
            break;
          default:
            break;
        }
      }

      for (let i = 0; i < concurrency; ++i) {
        // 生成 BEGIN/BDD 的isn
        let seq = utils.RandomNum(1, 100000);
        // 生成 rangesize, 如果非BDD，随机生成一个长度
        let rangesize = 4 // utils.RandomNum(1, 5);
        let seq_list = utils.Shuffle(utils.Range(seq, seq + rangesize));
        let gray = utils.RandomGray(seq_list, 0.2) || []
        LOG.info("Testing gray:", gray)
        seq_list.push(...gray);
        LOG.info("Testing all:", seq_list)
        // 添加到测试任务中
        t.addTask(utils.RandomNum(0, ACK_TIMEOUT), Task, seq, seq_list, peerInfo, rangesize);
      }
    }
  }

  /**
   * 虚拟连接器，管理和维护 发送 <---> 接收 两端的一次数据块，保证在这次传输过程中的唯一标识的，
   * 同时管理多个连接之间的传输细节
   */
  class Connector {
    constructor() {
      /**
       * 0 1 2 标准输入 标准输出 标准错误
       * 3 广播数据包 占用
       * 4 多播数据包 占用
       * 传输数据从5 开始使用
       */
      this.coonnset = new Fd();
    }

    // 新建一次新的传输过程，分配一个唯一的fd
    open(option) {
      let fd = this.coonnset.setInfo({
        option: option,
        time: utils.GetTimestamp(),
      });
      return fd;
    }
    // 关闭一次传输, 释放对应的fd
    close(fd) {
      this.coonnset.close(fd);
    }
    // 通过fd获取对应的信息
    fstat(fd) {
      return this.coonnset.getInfo(fd);
    }

    addInfo(fd, option) {
      this.coonnset.addInfo(fd, option)
    }
  }

  /**
   * 发送器
   * 业务层调用发送的接口，通过udp发送到对端，必要时做出重试，目的是保证数据可靠到达
   * 在一次单向的发送 <--> 接收 的过程中
   * 发送方：仅仅只会发送 BROAD ~ BDD
   * 接收方：仅仅只会发送 ABROAD ~ ABDD
   * 对于发送器来说，只会发送数据包，在超时时做出重试，此外是等待ACK，对资源做释放处理，对应的资源有：
   *   - fd 分配：标记一次传输过程的关联符号，open 创建 close 释放
   *   - seq 管理器：标记一次传输数据包的唯一标识，在一个数据块内可能在数据包较大时重复，但是在多个数据块之间禁止交叉重复。
   *   - timer 定时器：超时重试的定时功能，在ack后会被释放
   *
   * 概念:
   * - 数据块级别：表示一次独立的完整传输过程，比如一张图片，一段文本，一个视频，由被分离的数据包组装而成，必须包含 BEGIN -> DOING -> DONED / BDD 的数据包类型
   * - 发送器级别：一个完整的发送器等级，发送器可以同时支持发送多个不同的独立数据块传输（数据块级别），比如一段文字、一张图片 可以同时传输
   *
   * 关键成员功能作用:
   *
   * - timers: 发送器级别，管理所有发送的数据包的序号及其重试处理，以确保数据超时重试，且在收到ACK时释放，还有在重试超过某一限制时将会向发送方的业务层抛出错误，对应onErrs回调
   * - conn: 发送器/数据块级别，连接器，用于数据块传输过程中的发送方的seq的管理中心，用于标识定位发送的数据包是属于哪个数据块。
   * - seqer: 发送器级别，seq 管理器，用于在需要的时候分配和生成以及ACK时的释放，是数据块之间分组的核心模块。存在攻击风险。 TODO：优化管理效率，谨防恶意攻击
   * - stat: 发送器级别，发送的过程中统计信息，用于流控做分析准备，简单的限流工具.
   * - timeout, delta: 发送器级别，简单的限流工具，通过多次传输过程 send -> ack 之间的耗时均值，加上一个delta，作为后期的timer的timeout。
   * - repeat: 数据块级别，超时重试次数，超过该次数将会上抛异常回调。
   * - onSend: 数据块级别，数据包准备好，可以发送时的回调，用于屏蔽具体发送方式，上层觉得操作方法。
   * - onErrs: 数据块级别，单次传输超时时的重试次数，超过时将回调该函数，用户方便业务层异常提示，阈值为 repeat
   * - onDone: 数据块级别，数据块发送完成时的回调。
   *
   */
  class Sender {
    static prefix = PROTONAME + SEP + VERSION + SEP + 'sender' + SEP;
    constructor(options) {
      for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
      this.delta = 5;
      this.timers = {};               // 重试定时器
      this.stat = new Stat();         // 统计分析模块
      this.conn = new Connector();    // 虚拟连接器
      this.seqer = new SeqManage();   // seq 管理器
      this.initOptions(options);
    }

    defaultOptions = {
      onSend: () => { LOG.info("onSend callback: ", arguments) }, // 准备发送数据
      onErrs: () => { LOG.error("onErrs onErrs: ", arguments) }, // 重试次数过多异常
      onDone: () => { LOG.info("onDone callback: ", arguments); }, // 数据块发送完成
      timeout: ACK_TIMEOUT, // 重试的超时时间
      repeat: 10,
    }

    // 初始化cb options
    initOptions(option, value) {
      if (option && value) this[option] = value
      if (!value && typeof option === 'object') {
        for (var prop in option) {
          if (this.defaultOptions.hasOwnProperty(prop) && this.hasOwnProperty(prop))
            this[prop] = option[prop]
        }
      }
      return this
    }

    // 新建一次新的传输过程，分配一个唯一的fd
    open(option) {
      return this.conn.open(option)
    }

    // 关闭一次传输, 释放对应的fd
    close(fd) {
      this.conn.close(fd);
    }

    // 通过fd获取对应的信息
    fstat(fd) {
      return this.conn.fstat(fd);
    }

    // 补充fd信息
    addInfo(fd, option) {
      this.conn.addInfo(fd, option)
    }

    // 根据传输过程和payload调整数据包类型
    encode(fd, mtype, payload, max_size) {
      let seq = 0, overflow = false;
      let data = this.serialize(payload)
      if (data && data.length > max_size) {
        overflow = true;
        data = data.slice(0, max_size);
      }
      let size = data.length;
      let fstat = this.fstat(fd);
      if (!fstat)
        throw Errors(EBADFD, "bad or empty fd", fd);

      // 根据数据类型，改写mtype
      if (mtype === BEGIN) {
        // 首个数据包，将申请一个新的isn
        if (fstat && !fstat.isn) {
          /**
           * 消息数据包（小于PACK_SIZE），只用占用一个数据包, 即 BDD
           * 否则为 BEGIN， 标记一个数据块的其实数据包。
           */
          mtype = overflow ? BEGIN : BDD;
        } else {
          /**
           * size == max_size 传输过程数据包
           * size <  max_size 传输到最后一个数据包
           */
          mtype = (overflow && size == max_size) ? DOING : DONED;
        }
      }
      // 根据数据包类型，分配seq
      switch (mtype) {
        case BEGIN:
          seq = this.seqer.malloc(FACTOR * BASE_SECTION);
          fstat['isn'] = seq;
          break;
        case BDD: case BROAD: case MULTI:
          seq = this.seqer.malloc(1);
          fstat['isn'] = seq;
          break;
        case DOING: case DONED:
          seq = this.seqer.get(fstat['isn']);
          break;
        default:
          throw Errors(EHEADERTYPE, "invalid type", type);
      }
      let pkg = { seq: seq, size: size, type: mtype, payload: data, factor: FACTOR }
      let pack = new Package(mtype, 0, 0, 0, pkg);
      return { seq: seq, size: size, type: mtype, pack: pack }
    }

    encodeAck(mtype, seq, payload) {
      let data = this.serialize(payload)
      let pkg = { seq: seq, size: data.length, type: mtype, payload: data }
      let pack = new Package(mtype, 0, 0, 1, pkg);
      return { seq: seq, size: data.length, type: pack.header.Type(), pack: pack }
    }

    // 定时器超时重传
    retry(seq, mtype, ip, port, pack, ctx) {
      LOG.warn('retry: ', seq, mtype, ip, port, pack, ctx)
      this.stat.incr('retry');
      pack.setFlags(1, 0, 0); // 添加dup标志
      this.onSend(mtype, ip, port, pack.buffer, 1);
      // 防止死循环，导致无限重试
      if (this.timers[Sender.prefix + seq].repeat < this.repeat) {
        this.timers[Sender.prefix + seq].restart(this.timeout);
      } else {
        this.onErrs(seq, mtype, ip, port, pack);
      }
    }

    // 向某个ip:port发送类型mtype的消息data
    write(fd, ip, port, mtype, payload) {
      let body = null;
      if (mtype < ABROAD) {
        let PACK_SIZE = utils.IsLanIP(ip) ? WAN_PACK_SIZE : LAN_PACK_SIZE;
        body = this.encode(fd, mtype, payload, PACK_SIZE);  // 编码数据包
      } else {
        body = this.encodeAck(mtype, payload, '');          // 编码数据包ACK
      }
      let { seq, size, type, pack } = body;
      this.onSend(mtype, ip, port, pack.buffer);
      // TODO: 广播，多播 是否需要重传？
      (type > MULTI && type < ABROAD) && this.addSeqTimer(seq, type, ip, port, pack);
      return size;
    }

    // 释放重试定时器, 释放seq段， mtype >= ABOARD
    free(seq, mtype) {
      let seqTimer = this.timers[Sender.prefix + seq];
      // 释放定时器
      if (mtype > AMULTI) {
        if (seqTimer) {
          seqTimer.stop();
          delete this.timers[Sender.prefix + seq];
        }
      }
      // 删除发送窗口中的分配的序号
      // LOG.info("free Ack:", seq, HeaderType[mtype])
      let isn = this.seqer.location(seq)
      if (isn >= 0) {
        // 释放seq，BEGIN / DOING 是否中间的seq
        if (ABEGIN === mtype || ADOING === mtype) {
          this.seqer.del(seq, isn);
        } else {
          this.seqer.free(isn);
        }
      }
    }

    // 添加seq 重试定时器
    addSeqTimer(seq, type, ip, port, pack) {
      let seqTimer = new timer({
        onend: (args) => { this.retry(...args); },
        onstop: (args) => {
          this.stat.incr('packcnt');
          this.stat.avg('spendavg', args.spend);
          LOG.info("onstop: ", args.spend, this.timeout, this.stat.get('spendavg'));
          // 数据包发送超过 this.repeat， 尝试风险timeout
          if (0 === this.stat.get('packcnt') % this.repeat) {
            this.timeout = Math.ceil(this.stat.get('spendavg'), this.delta);
            this.stat.del('spendavg');
          }
          // 如果发现超时重传，将扩大增量值为之前的2倍
          if (this.stat.get('retry')) {
            this.delta >>= 1;
          }
          // 当delta 大于超时值，将恢复到一半
          if (this.delta > this.timeout) {
            this.delta <<= 2;
          }
        }
      }, [seq, type, ip, port, pack, this]);
      // 记录下每个数据包的定时器，在必要的时候重置定时器
      this.timers[Sender.prefix + seq] = seqTimer;
      seqTimer.start(this.timeout);
    }

    // serialize the data
    serialize(data) {
      let type = utils.Type(data);
      switch (type) {
        case "Number":
          return data;
        case "String":
          return data;
        case "Array":
        case "Object":
          return JSON.stringify(data)
        case "Boolean":
          return (data === true) ? 1 : 0;
        case "Undefined":
        case "Null":
          return '';
        default:
          return '';
      }
    }
  }

  /**
   * 本kudp 基于wx.UDPSocket的基础类实现
   * 基于udp协议实现可靠传输，为更上层应用层提供可靠的"传输层"！
   * 几个说明
   *   - 基于udp协议
   *   - 实现可靠的传输
   *   - 封装过程不保持长连接
   *   - 基于数据报而不是字节流
   *   - 不做拥塞控制，只要设法保证数据不错、不丢、不乱
   *
   * 整个实现分 3大模块 1个辅助模块
   * - 逻辑模块: 管理其他模块的逻辑层，对接udp，负责接收和发送udp数据。对接收到的数据，给接收器处理；对于发送的数据逻辑，交给发送处理；对于传输过程的中的统计类交给统计器
   * - 发送器: 负责从业务层获取数据，通过逻辑模块的udp封装，发送到网络中；同时要管理连接分配、释放，seq的分配、释放，超时重试机制，发送异常回调。
   * - 接收器: 负责处理来自逻辑模块从udp封装的接口回调的网络数据，保证在接受到数据块后，第一时间回复ACK，然后定时释放接收到的seq，还有就是上报数据到业务层的逻辑。
   * - 统计器: 负责在发送和接收到数据后的统计工作，不同类型的数据包统计，最重要的是 dup 值的统计，方便后期流控和网络传输过程的中网络状态统计分析
   *
   * 公开接口:
   *   open: 新建一个虚拟连接标识，该标识只在发送端存在
   *   close: 关闭open新建的标识，同时释放所有open申请的资源
   *   write: 通过发送器向网络发送一个数据块
   *   sync: 通过发送器发送一个特殊数据包
   *   broadcast: 通过发送器发送一个特殊数据包，广播类型
   *   multicast: 通过发送器发送一个特殊数据包，多播类型，NOTE: 基于wx.UDPSocket 不支持多播
   * 公开的业务层回调接口:
   *   onRead: 从接收器获取到数据后，回调到业务层的接口
   *   onWrite: 向发送器发送数据后的回调业务层的接口，目前是否无用
   *   onStat: 统计器向业务层回调的统计数据接口
   *
   * 考虑到目前业务支持，目前仅提供以上接口，后期版本申请将会根据需要信息，每一次升级版本，将会更新 VERSION。
   */
  class kudp extends UdpBase {
    constructor(port, options) {
      super(port);
      for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
      this.bport = port;        // udp通信绑定的port，默认5328
      this.stat = new Stat();   // 统计分析模块
      this.sQueue = new Sender({
        onSend: this._onSend.bind(this),
        onErrs: this._onErrs.bind(this),
      })
      this.rQueue = new Recver({
        onUp: this._handleOnMessage.bind(this),
        onEcho: this._sendAck.bind(this),
        onAck: this._handleAckMessage.bind(this),
        onTick: this.recvStat.bind(this),
      });
      this.initOptions(options);
      this._init();
    }

    defaultOptions = {
      onRead: null,   // 读取到网络上的数据回调
      onWrite: null,  // 向网络发送数据时回调
      onStat: null,   // 数据分析统计回调
      onErr: null,    // 传输异常时回调
    }

    // 初始化cb options
    initOptions(option, value) {
      if (option && value) this[option] = value
      if (!value && typeof option === 'object') {
        for (var prop in option) {
          if (this.defaultOptions.hasOwnProperty(prop) && this.hasOwnProperty(prop))
            this[prop] = option[prop]
        }
      }
      return this
    }

    // 初始化udp相关回调
    _init() {
      if (this.kudper) {
        this.onListening();
        this.offListening();
        this.onMessage();
        this.offMessage();
        this.onClose();
        this.offClose();
      }
    }

    // 接受数据时的回调
    _onMessageHandler(res) {
      this.rQueue.onMessage(res);
    }

    // 发送数据回调
    _onSend(mtype, ip, port, message, dup) {
      this.sendStat(mtype, dup);
      return this.send(ip, port, message);
    }

    // 传输异常回调
    _onErrs(seq, mtype, ip, port, pack) {
      this.onErrs && this.onErrs();
    }

    // 接收消息的统计
    recvStat(mtype, err) {
      // STAT 统计接收数据包个数，错误数据包个数, 比如checksum error
      (0 === err) ? this.stat.incr('rpgc') : this.stat.incr('erpgc');
      mtype >= ABROAD && this.stat.incr('rackpgc');  // 确认包
      mtype === BDD && this.stat.incr('rspgc');      // STAT 统计接收小型数据包个数
      mtype <= DONED && this.stat.incr('rnspgc');    // STAT 统计接收非小型数据包个数
      mtype === BROAD && this.stat.incr('rnspgc');   // TODO: 广播 暂时当作非小型数据包
      mtype === MULTI && this.stat.incr('rnspgc');   // TODO: 组播 暂时当作非小型数据包
      this.onStat && this.onStat('recv', this.stat);
    }

    // 发送消息的统计
    sendStat(mtype, dup) {
      this.stat.incr('pgc');                        // STAT 统计发送数据包个数
      mtype >= ABROAD && this.stat.incr('ackpgc');  // 确认包
      mtype === BDD && this.stat.incr('spgc');      // STAT 统计发送小型数据包个数
      mtype !== BDD && this.stat.incr('nspgc');     // STAT 统计发送非小型数据包个数
      mtype === BROAD && this.stat.incr('nspgc');   // TODO: 广播 暂时当作非小型数据包
      mtype === MULTI && this.stat.incr('nspgc');   // TODO: 组播 暂时当作非小型数据包
      (1 === dup) && this.stat.incr('dup');         // TODO 重复数据包
      this.onStat && this.onStat('send', this.stat);
    }

    // 处理来自网络的确认包
    _handleAckMessage(mtype, seq, peerInfo, message) {
      let data = {
        seq: seq,
        message: message,
        IPinfo: peerInfo,
        iPint: peerInfo.ipint,
      };
      // 针对数据包不同类型特殊处理
      switch (mtype) {
        case ABROAD:
          break;
        case AMULTI:
          break;
        case ABEGIN:
          break;
        case ADOING:
          break;
        case ADONED:
          break;
        case ABDD:
          break;
        default:
          break;
      }
      this.sQueue.free(seq, mtype);
    }

    // 处理来自网络的数据包
    _handleOnMessage(isn, mtype, seq, peerInfo, payload) {
      this.onRead && this.onRead(isn, mtype, seq, peerInfo, payload);
    }

    // 由于数据包会再未收到对应ACK包时会重传，针对ACK包无需设置超时重传
    _sendAck(ip, port, mtype, seq) {
      // LOG.info("sendAck:", seq, HeaderType[mtype]);
      return this.sQueue.write(null, ip, port, mtype | ABROAD, seq);
    }

    // 新建一次新的传输过程，分配一个唯一的fd
    open(ip, port, flag) {
      return this.sQueue.open(ip, port, flag);
    }

    // 关闭一次传输, 释放对应的fd
    close(fd) {
      this.sQueue.close(fd);
    }

    // 基础网络方法
    // 通过id发送mtype消息的数据data
    write(fd, payload, ip, port, flag) {
      let self = this;
      this.sQueue.addInfo(fd, { ip: ip, port: port })
      let size = self.sQueue.write(fd, ip, port, flag || BEGIN, payload);
      this.onWrite && this.onWrite(fd, payload, ip, port);
      return size;
    }

    // 向某一个设备id发送同步类型的数据，主要是同步本设备的数据更新
    sync(ip, port, payload, mtype) {
      return this.sQueue.write(FD_BROAD, ip, port, mtype || BROAD, payload);
    }

    // 广播数据包
    broadcast(payload) {
      return this.sync(BROADWAY, this.bport, payload || "");
    }

    /**
     * TODO: 组播多播数据包
     * IP多播通信必须依赖于IP多播地址，在IPv4中它是一个D类IP地址，范围从224.0.0.0 ~ 239.255.255.255，
     * 并被划分为局部链接多播地址、预留多播地址和管理权限多播地址三类：
     * 1. 局部链接多播地址: 224.0.0.0 ~ 224.0.0.255，为路由协议和其它用途保留的地址，路由器并不转发属于此范围的IP包；
     * 2. 预留多播地址: 224.0.1.0 ~ 238.255.255.255，可用于全球范围（如Internet）或网络协议；
     * 3. 管理权限多播地址: 239.0.0.0 ~ 239.255.255.255，可供组织内部使用，类似于私有IP地址，不能用于Internet，可限制多播范围。
     */
    multicast(payload, multiway) {
      return this.sync(multiway, this.bport, payload || "", MULTI);
    }
  }

  // 业务基于kudp 实现业务功能
  class kudper {
    constructor(port, event) {
      // 用于与业务层的事件通知，将通知上报到业务层
      this.event = event;
      this.online = { length: 0 };
      this.kudp = new kudp(port, {
        onRead: this.recvFrom.bind(this),
        onStat: this.statist.bind(this),
        onErrs: () => {
          LOG.error("kudper onErrs");
          wx.showToast({
            title: '网络有点小问题',
            icon: 'loading'
          });
        }
      });
      this.id = this.getId();   // 获取随机分配的设备id，用于唯一标识
      this.init();
    }

    // 初始化各类回调
    init() {
      let self = this
      wx.onNetworkStatusChange(function (res) {
        self.offline()
        wx.showToast({
          title: '网络有点小问题',
          icon: 'loading'
        });
        self.getLocalip(true);
        setTimeout(() => {
          wx.hideToast({
            complete: (res) => { },
          })
        }, 1000)
      })
    }

    // 获取分配的随机id
    getId() {
      let id = null
      try {
        let res = cache.get('LOCAL');
        if (res) {
          id = res
        } else {
          id = utils.RandomNum(0, IDMAX)
          cache.set('LOCAL', id, EXPIRE);
        }
      } catch (e) {
        id = utils.RandomNum(0, IDMAX)
        cache.set('LOCAL', id, EXPIRE);
      }
      id = utils.Pad(id, IDLEN)
      return id
    }

    // 发送上线广播通知
    connect() {
      return this.kudp.broadcast('@' + this.id);
    }
    // 下线广播
    offline() {
      if (this.online[this.id]) {
        return this.kudp.broadcast('-' + this.id);
        // this.upper.close()
      }
    }

    // 添加上线用户id address port
    _addOnline(id, address, port) {
      let one = this.online[id];
      if (!one) {
        this.online.length++;
      }
      this.online[id] = {
        address: address,
        port: port
      };
      this.online[address] = id;
      LOG.info("addOnline +++: ", this.online[id]);
      return this.online[id];
    }

    // 删除下线用户id
    _delOnline(id) {
      let one = this.online[id];
      if (one) {
        delete this.online[id];
        delete this.online[one.address];
        this.online.length--;
        LOG.info("delOnline --: ", one);
      }
      return one;
    }

    // 消息处理方法

    // 处理[SYNC数据包]设备上下线，各设备之间数据同步的功能
    _handleSync(data) {
      let one = null
      data.message = data.message + ''
      let method = data.message[0];
      data.message = data.message.slice(1);
      switch (method) {
        case '@':
          return this._handleLocal(data);
        case '+':
          one = this._addOnline(data.message, data.IPinfo.address, data.IPinfo.port);
          break;
        case '-':
          one = this._delOnline(data.message);
          break;
        default:
          break;
      }
      data.online = this.online.length;
      one && this.event.emit("onMessage", data);
      return data;
    }

    // 处理[LOCAL数据包]设备ip地址获取的功能
    _handleLocal(data) {
      let one = this._addOnline(data.message, data.IPinfo.address, data.IPinfo.port);
      if (data.message == this.id) {
        one.id = this.id;
        data.id = this.id;
        data.type = "LOCAL"
        this.event.emit("onMessage", data);
      } else {
        // 向新上线的用户推送所有在线
        this.kudp.sync(data.IPinfo.address, data.IPinfo.port, '+' + this.id);
      }
      return one;
    }

    // 处理多播情况 TODO
    _handleMulti(data) {
      // 此时message 是当前上线的用户id
      let one = this._addOnline(data.peerId, data.IPinfo.address, data.IPinfo.port);
      // 如果是本设备
      if (data.peerId == this.id) {
        data.id = this.id;
        this.event.emit("onMessage", data);
      } else {
        // 向新上线的用户推送所有在线
        this.kudp.sync(data.IPinfo.address, data.IPinfo.port, '+' + this.id);
      }
    }

    // 连接管理
    open(ip, port, flag) {
      return this.kudp.open(ip, port, flag);
    }

    close(fd) {
      return this.kudp.close(fd);
    }

    sendTo(fd, payload, ip, port) {
      let PACK_SIZE = utils.IsLanIP(ip) ? WAN_PACK_SIZE : LAN_PACK_SIZE;
      let psize = Buffer.byteLength(payload, 'utf8')
      LOG.info("sendTo:", psize)
      if (psize <= PACK_SIZE) {
        return this.kudp.write(fd, payload, ip, port);
      }
      let times = Math.ceil(psize / PACK_SIZE)
      for (let i = 0; i < times; ++i) {
        let data = payload.slice(i, (i + 1) * PACK_SIZE + 1);
        if (i + 1 === times)
          this.kudp.write(fd, data, ip, port, DONED);
        else
          this.kudp.write(fd, data, ip, port);
      }
      return 0;
    }

    recvFrom(isn, mtype, seq, peerInfo, payload) {
      let data = {
        isn: isn,
        seq: seq,
        message: payload,
        IPinfo: peerInfo,
        iPint: peerInfo.ipint,
      };
      switch (mtype) {
        case BROAD:
          data.type = 'BROAD';
          this._handleSync(data);
          break;
        case MULTI:
          data.type = 'MULTI';
          this._handleMulti(data);
          break;
        case BEGIN:
          data.type = 'BEGIN';
          this.event.emit("onMessage", data);
          break;
        case DOING:
          data.type = 'DOING';
          this.event.emit("onMessage", data);
          break;
        case DONED:
          data.type = 'DONED';
          LOG.info("recvFrom: ", data.message);
          this.event.emit("onMessage", data);
          break;
        case BDD:
          data.type = 'BDD';
          this.event.emit("onMessage", data);
          break;
        default:
          data.type = mtype;
          this.event.emit("onMessage", data);
          break;
      }
      console.info("online", this.online);
      console.info("current", this);
    }

    sendFile(fd, path, ip, port) {
      LOG.info("sendFile: ", fd, path, ip, port)
    }

    // 工具方法

    // 获取最新的本设备的ip， 默认从缓存获取，否则再次发送广播获取
    getLocalip(forse) {
      if (!forse) {
        return this.online[this.id];
      } else {
        this.connect();
      }
    }

    // 获取本设备信息， 从缓存获取
    getSelf() {
      return this.online[this.id];
    }

    // 获取除本设备的其他所有设备, 如果id存在，即获取对应的信息
    getOthers(id) {
      if (id) {
        return this.online[id] ? [this.online[id]] : null;
      }
      let online = [];
      let copy = Object.assign({}, this.online);
      for (let prop in copy) {
        if (prop != 'length' && 'string' != (typeof copy[prop]) /* && prop != this.id*/) {
          online.push(copy[prop]);
        }
      }
      return online;
    }

    // 统计工具
    statist(type, stat) {
      if ('recv' !== type)
        return;
      let format_str = ""
      for (let key in stat.props) {
        // LOG.info(key, stat.props[key]);
        if ('pgc' == key) {
          format_str = format_str + "\n" + "发送数据包：" + stat.props[key]
        } else if ('rpgc' == key) {
          format_str = format_str + "\n" + "接收数据包：" + stat.props[key]
        } else if ('ackpgc' == key) {
          format_str = format_str + "\n" + "发送确认数据包：" + stat.props[key]
        } else if ('rackpgc' == key) {
          format_str = format_str + "\n" + "接收确认数据包：" + stat.props[key]
        } else if ('dup' == key) {
          format_str = format_str + "\n" + "dup值：" + stat.props[key]
        } else if ('spgc' == key) {
          format_str = format_str + "\n" + "发送小型数据包：" + stat.props[key]
        } else if ('nspgc' == key) {
          format_str = format_str + "\n" + "发送非小型数据包：" + stat.props[key]
        } else if ('rspgc' == key) {
          format_str = format_str + "\n" + "接收小型数据包：" + stat.props[key]
        } else if ('rnspgc' == key) {
          format_str = format_str + "\n" + "接收非小型数据包：" + stat.props[key]
        } else if ('erpgc' == key) {
          format_str = format_str + "\n" + "错误数据包：" + stat.props[key]
        }
      }
      format_str = format_str.slice(1)
      this.event.emit("kudp-stat", format_str);
      return format_str
    }
  }

  exports.kudper = kudper;
  exports.Header = Header;
  exports.SeqManage = SeqManage;
  exports.Recver = Recver;
});