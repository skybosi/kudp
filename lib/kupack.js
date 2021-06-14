/**
* format：
*          7      6      5      4      3      2      1      0   
*      +------+------+------+------+------+------+------+------+
*      | ack  |   version   |  qos |  dup |        type        | 头部（1byte）
*      +------+------+------+------+------+------+------+------+
*      |                    Task Number(1 byte)                | 任务号（1byte）
*      +------+------+------+------+------+------+------+------+
*      |                 Sequence Number(3 byte)               | 序列号（3byte）
*      +------+------+------+------+------+------+------+------+
*      |                   payload(nbyte)                      | 数据（nbyte）
*      +------+------+------+------+------+------+------+------+
*
*  头部: 
*      type 位(bit 0~2):
*          000: 发送广播数据包 BROAD           001: 发送多播数据包 MULTI
*          010: 发送开始数据包 BEGIN           011: 发送中间数据包 DOING
*          100: 发送结束数据包 DONED           101: 开始中间结束数据包 BDD  对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
*      dup 位(bit 3):
*          表示一个数据包在传输时是否因为原因重试，如果是重试即置为1，否则为0（默认0）
*      dup 值:
*          依赖dup标志统计出的一个值，用来衡量传输的环境优劣程度。
*      qos 位(bit 4):
*          表示是否是服务质量，待定是否需要
*      version (bit 5~6):
*          占用 4bit，即 2^2 = 4 个版本。当前版本 0。
*      ack 位(bit 7)
*          表示type对应的数据包对应的确认包，在qos 为 1时
*
*  任务号：
*      与同一个端，同时最多的发送任务数为256个，每一个完整的传输占用一个序号，超过256个时会报错禁止再次创建发送任务
*
*  序列号:
*      一次小型数据传输过程，占用一个数字
*      一次中大型数据传输，每次完整的send + ack 后会自增，知道溢出后，从0开始回绕
*
*  数据:
*      固定长度，最长MAX_PAGE（512byte），小于该值即为结束了
*
*  NOTE：
*      1. 任务号最大255,目的是防止在两端产生过多的任务，对两端的内存及网络io造成较大的压力
*      2. 序列号在一对传输设备中可能重复，但是与任务号配合后将不会重复，只有该任务发送完毕后可以再次被使用
*
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

  // header leng
  const HEADER_LEN = 5

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
   * 数据包头解析, ver 默认为0 
   */
  class Header {
    constructor(type, dup, qos) {
      this.bits = 0
      if (!this.invalidType(type)) {
        throw Errors(EHEADERTYPE, "invalid type", type);
      }
      this.setType(type);
      (dup === 1) ? this.setDup(dup) : null;
      (qos === 1) ? this.setQos(qos) : null;
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
    Version() {
      return (this.bits & 0x60) >>> 5;
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
      for (let key in rHeaderType) {
        let head1 = new Header(rHeaderType[key]);
        heads.push(head1.header());
        console.log("type Tesing info:", head1.info());
        console.log("type Tesing data:", head1.header());
        console.log("type Tesing Type:", head1.Type());
        console.log("type Tesing Qos:", head1.Qos());
        console.log("type Tesing Dup:", head1.Dup());
        console.log("type Tesing Ack:", head1.Ack());
      }
      // Dup test
      for (let key in rHeaderType) {
        let head1 = new Header(rHeaderType[key], 1);
        heads.push(head1.header());
        console.log("dup Tesing info:", head1.info());
        console.log("dup Tesing data:", head1.header());
        console.log("dup Tesing Type:", head1.Type());
        console.log("dup Tesing Qos:", head1.Qos());
        console.log("dup Tesing Dup:", head1.Dup());
        console.log("dup Tesing Ack:", head1.Ack());
      }
      // Qos test
      for (let key in rHeaderType) {
        let head1 = new Header(rHeaderType[key], 0, 1);
        heads.push(head1.header());
        console.log("qos Tesing info:", head1.info());
        console.log("qos Tesing data:", head1.header());
        console.log("qos Tesing Type:", head1.Type());
        console.log("qos Tesing Qos:", head1.Qos());
        console.log("qos Tesing Dup:", head1.Dup());
        console.log("qos Tesing Ack:", head1.Ack());
      }
      // All test
      for (let key in rHeaderType) {
        let head1 = new Header(rHeaderType[key], 1, 1);
        heads.push(head1.header());
        console.log("all Tesing info:", head1.info());
        console.log("all Tesing data:", head1.header());
        console.log("all Tesing Type:", head1.Type());
        console.log("all Tesing Qos:", head1.Qos());
        console.log("all Tesing Dup:", head1.Dup());
        console.log("all Tesing Ack:", head1.Ack());
      }
      // test New
      for (let i in heads) {
        let header = Header.New(heads[i])
        console.log("Tesing new info:", header.info());
      }
    }
  }

  /**
   * package 解析器
   */
  class Package {
    constructor(type, dup, qos, task_seq, payload = "") {
      this.header = null;
      this.buffer = null;
      if ("Number" === utils.Type(type)) {
        this.header = new Header(type, dup, qos);
      }
      this.task_seq = task_seq;
      this.payload = payload;
      if (null != this.task_seq && undefined != this.task_seq) {
        this.build(this.header, this.task_seq, this.payload);
      }
    }

    // 构建pack
    build(header, task_seq, payload) {
      let msg = Package.pack(header, task_seq, payload);
      this.buffer = msg.buffer
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

    // 编码数据包结构, payload is Buffer
    static pack(header, task_seq, payload = "") {
      let psize = payload.length
      let msg = new Buffer(psize + HEADER_LEN);
      /** 写入header数据 */
      msg.writeUInt8(header.header());    // 0
      msg.writeUInt32BE(task_seq);             // 1 ~ 4
      /** 写入数据包内容 */
      if (Buffer.isBuffer(payload)) {     // 5~ 消息内容
        msg.writeBuffer(payload)
      } else if (typeof payload == "string") {
        msg.write(payload, HEADER_LEN)
      }
      return msg
    }

    // 解码数据包
    static unpack(buffer) {
      let pkg = new Package()
      let msg = new Buffer(buffer)
      /** 从buffer 读出header */
      pkg.buffer = msg.buffer
      pkg.header = Header.New(msg.readUInt8());     // 0
      pkg.task_seq = msg.readUInt32BE(1);            // 1 ~ 4
      /** 从buffer 读出消息内容 */
      pkg.payload = msg.slice(HEADER_LEN);          // 5~ 消息内容
      pkg.version = pkg.header.Version()
      let { task, seq } = SeqManage.decode(pkg.task_seq)
      pkg.task = task
      pkg.seq = seq
      return pkg
    }

    static testPackage() {
      let i = 0
      for (let key in rHeaderType) {
        let type = rHeaderType[key]
        let head = new Header(type);
        let pkg = new Package(type, 0, 0, i, "Test-Package:" + key + " Qos:0");
        let unpkg = Package.unpack(pkg.buffer);
        console.log(type, head, pkg, unpkg)
        i = i + 1
      }
      console.log("--------------------------------")
      for (let key in rHeaderType) {
        let type = rHeaderType[key]
        let head = new Header(type);
        let pkg = new Package(type, 0, 1, i, "Test-Package:" + key + " Qos:1");
        let unpkg = Package.unpack(pkg.buffer);
        console.log(type, head, pkg, unpkg)
        i = i + 1
      }
      console.log("--------------------------------")
      for (let key in rHeaderType) {
        let type = rHeaderType[key]
        let head = new Header(type);
        let pkg = new Package(type, 1, 1, i, "Test-Package:" + key + " Qos:1");
        let unpkg = Package.unpack(pkg.buffer);
        console.log(type, head, pkg, unpkg)
        i = i + 1
      }
    }
  }
  // Package.prototype.unpack = unpack

  exports.Header = Header;
  exports.Package = Package;

  exports.BROAD = BROAD  // 广播数据包
  exports.MULTI = MULTI  // 多播数据包
  exports.BEGIN = BEGIN  // 首个数据包
  exports.DOING = DOING  // 大型数据包中间数据包
  exports.DONED = DONED  // 结束数据包
  exports.BDD = BDD      // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包

  exports.ABROAD = ABROAD  // 广播数据包
  exports.AMULTI = AMULTI  // 多播数据包
  exports.ABEGIN = ABEGIN  // 首个数据包
  exports.ADOING = ADOING  // 大型数据包中间数据包
  exports.ADONED = ADONED  // 结束数据包
  exports.ABDD = ABDD      // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
});