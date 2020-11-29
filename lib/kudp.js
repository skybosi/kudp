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
    const BitSet = require('./common/BitSet.js')
    const seqTree = require('./common/tree').RBTree
    const task = require('./common/task')
    const timer = require('./common/timer')
    const heapify = require('./common/heapify')
    const Buffer = require('./common/Buffer/Buffer.js')
    const Stat = require('./common/Stat.js')

    const UdpBase = require('./UdpBase')

    const PROTONAME = 'kudp'
    const VERSION = 0x0 // kudp version

    const SEP = '/'

    const RIGHT_MOVE = 11
    const ISN_INTERVAL = 1 << RIGHT_MOVE  // 2048
    const MAX_SEQ = (-1 >>> 32) + 1
    const FACTOR = 4     // 默认放大因子
    const BASE_SECTION = 256 // 基础段长度
    const KUDP_SNDBUF = 4194304 // 4 * 1024 * 1024 byte
    const KUDP_RCVBUF = 4194304 // 4 * 1024 * 1024 byte

    // 重传机制超时时间
    const ACK_TIMEOUT = 400
    const ACK_ECHO_TIMEOUT = 200
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
    LOG.level = 'info';
    LOG.func = function (funcName) {
        return function (...msg) {
            if (LOG.level_[funcName] < LOG.level_[LOG.level]) { return; }
            if (console && console[funcName]) {
                console[funcName](...msg);
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
                segment_tb = [[segment[0], seq], [seq + size, segment[1]]]
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
                let lo = Math.floor((this.data[isn]['cursor'] - isn) / this.data[isn]['length']);
                let off = (this.data[isn]['cursor'] - isn) % this.data[isn]['length'];
                let seq = isn + off;
                // 写入一个待确认的seq
                this.data[isn]['cursor']++;
                if (this.data[isn]['cursor'] >= this.data[isn]['last']) {
                    // LOG.info("isn, seq, last", isn, seq, this.data[isn]['last'])
                }
                this.data[isn]['ack'].push(seq)
                return [seq, lo]
            }
            return [-1, -1];
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
                this.lo = pkg.lo || 0;
                this.build(this.header, this.seq, this.payload, this.factor, this.lo);
            }
        }

        // 构建pack
        build(header, seq, payload, factor, lo) {
            let [msg, checksum] = Package.pack(header, seq, payload, factor, lo);
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

        // 编码数据包结构, payload is Buffer
        static pack(header, seq, payload, factor, lo) {
            let psize = payload.length
            let msg = new Buffer(psize + HEADER_LEN);
            /** 写入header数据 */
            msg.writeUInt8(header.header());    // 0
            msg.writeUInt32BE(seq);             // 1 ~ 4
            msg.writeUInt16BE(0x0);             // 5 ~ 6
            if (BEGIN === header.Type()) {
                // 消息区段
                let rangesize = factor || FACTOR;
                let lastlen = (rangesize << 4) | VERSION;
                msg.writeUInt8(lastlen);          // 7 消息区段 + version
            } else if (BDD === header.Type()) {
                // 消息区段
                let rangesize = 0
                let lastlen = (rangesize << 4) | VERSION;
                msg.writeUInt8(lastlen);          // 7 消息区段 + version
            } else {
                msg.writeUInt8(lo);               // 7 消息区段 + version
            }
            /** 写入数据包内容 */
            msg.writeBuffer(payload)           // 8 消息内容
            let checksum2 = utils.Crc16(msg);
            msg.writeUInt16BE(checksum2, 5);    // 5 ~ 6 消息checksum 2byte
            // LOG.debug("pack compare2:", msg, msg.toString() == msg.toString())
            return [msg, checksum2];
        }

        // 解码数据包
        static unpack(buffer) {
            let pkg = new Package();
            let msg = new Buffer(buffer)
            /** 从buffer 读出header */
            pkg.lo = 0;
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
            } else {
                pkg.lo = msg.readUInt8(7);
            }
            // if (pkg.lo > 0) {
            //     LOG.info(pkg)
            // }
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
                time: +new Date,
            });
            this.setBit(FD_MULTI, {
                fd: FD_MULTI,
                flag: MULTI,
                time: +new Date,
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

    class RecvBuffer {
        constructor(cap, isn) {
            this._cap = cap;    // 最大容量
            this._isn = isn || 0;
            this.init();
        }

        init() {
            this._buffer = [];  // 接收数据数组
            this._stage = [];   // 乱序的序号下标
            this._begin = 0;    // 当前连续的未被读取起始下标
            this._end = 0;      // 当前连续的未被读取终止下标
            this._lo = 0;       // 当前循环轮次
            this._los = { 0: 1 };  // 接收的轮次计划
        }
        /**
         * 由于buffer 容量固定，在不断写入到对应位置时，且在达到容量上限时，为了避免内存空间
         * 的过多消耗，采用下标回滚到方式复用空间，此时原有的数据被覆盖，但是需要有以下前提：
         * 1. 原有的下标的数据已经被读出 (pos 不在 this._begin 与 this._end 之间)
         * 2. 不是重复的数据（lo == this._lo）
         */
        push(pos, lo, data) {
            pos -= this._isn;
            if (pos >= this._cap)
                return 1;
            if (this._los[lo]) {
                // 重复数据，直接丢弃
                if (pos >= this._begin && pos < this._end) {
                    return 2
                }
            } else {
                // 原有的下标的数据未被读出，禁止覆盖，返回写入异常, TODO 此处是否需要缓存下来
                if (pos >= this._begin) {
                    // 缓存lo + 1 的数据, 避免过多的重复发送， 但是又避免过多缓存耗费内存
                    if (lo - 1 == this._lo)
                        utils.pushAtSortPosition(this._stage, [pos, lo, data], this.stage_cmp, true)
                    return 3
                }
                this._los[lo] = 1;
            }
            // this._buffer[pos] = data;
            /**
             * 将当前pos 放入乱序的首位，如果pos 正好是this._eoff期待的这个下标，将优先处理，
             * 之后的循环过程顺便处理曾经先到达的乱序下标(说明存在空洞，即说明有先到的数据包)
             */
            utils.pushAtSortPosition(this._stage, [pos, lo, data], this.stage_cmp, true)
            this.checkStage();
            return 0
        }

        get cap() { return this._cap; }
        get size() { return this._end - this._begin; }
        get end() { return this._end; }
        get begin() { return this._begin; }
        get empty() { return this._end == this._begin; }
        stage_cmp(a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }

        clear() {
            this.init();
        }

        // 检测乱序缓存，试图迁移到正序的 _buffer
        checkStage() {
            this._stage = this._stage.filter((element) => {
                if (element[0] == this._end && element[1] == this._lo) {
                    this._end++;
                    this._buffer[element[0]] = element[2];
                    return false;
                }
                return true;
            });
            /*
                let stage = []
                for (let j = 0, len = this._stage.length; j < len; j++) {
                    if (this._stage[j][0] == this._end && this._stage[j][1] == this._lo) {
                        this._end++;
                        this._buffer[this._stage[j][0]] = this._stage[j][2];
                    } else {
                        stage.push(this._stage[j]);
                    }
                }
                this._stage = stage;
            */
        }

        /**
         * 从buffer读取所有有序的数据, 当读到最后，回滚偏移位置
         */
        pop() {
            let begin = this._begin, end = this._end;
            if (this._end == this._cap) {
                delete this._los[this._lo];
                this._los[++this._lo] = 1;
                this._end = this._end % this._cap;
            }
            this._begin = this._end;
            let ret = this._buffer.slice(begin, end);
            // 说明当前轮次结束, 可能存在stage的数据需要写入_buffer
            if (end >= this._cap) {
                this.checkStage();
                begin = this._begin, end = this._end;
                if (begin != end) {
                    this._begin = this._end;
                    ret = ret.concat(this._buffer.slice(begin, end));
                }
            }
            return ret
        }

        static testRecvBuffer() {
            let cap = 6
            let rb = new RecvBuffer(cap, 0);
            // 小于Buffer cap
            let i = 0, max = 5, size = 5; // max 最大序号 size 上报最小size
            let data = utils.Shuffle(utils.Range(0, max)); // [3, 0, 4, 1, 2]
            while (i < max) {
                let dt = data[i]
                rb.push(dt, 0, "data:" + dt);
                if (rb.size >= size) {
                    LOG.info(i, rb.pop());
                }
                i++;
            }
            if (!rb.empty) {
                LOG.info(i, rb.pop());
            }
            rb.clear();
            LOG.info(data);
            // 大于Buffer cap
            i = 0, max = 4 * cap, size = 5; // max 最大序号 size 上报最小size
            data = utils.Shuffle(utils.Range(0, max)); // [2, 4, 5, 8, 7, 3, 11, 1, 9, 10, 0, 6]
            while (i < data.length) {
                let lo = Math.floor(data[i] / cap);
                let dt = data[i] % cap
                rb.push(dt, lo, "data:" + lo + ":" + data[i]);
                if (rb.size >= size) {
                    LOG.info(i, rb.pop());
                }
                i++;
            }
            if (!rb.empty) {
                LOG.info(i, rb.pop());
            }
            LOG.info(data);
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
     * - onErrs: 数据块级别，数据包接收过程异常时回调，TODO：怎么判断异常？
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
        timerPrefix = Recver.prefix + "isn" + SEP;
        max_stage = KUDP_RCVBUF / LAN_PACK_SIZE;
        constructor(options) {
            this.timers = {};
            this.staging = {};
            this.stage_size = 0;
            this.stat = new Stat();
            for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
            this.queue = new seqTree(Recver.prefix, (a, b) => a.seq - b.seq); // 并发传输多个数据块的处理队列
            this.initOptions(options);
        }

        defaultOptions = {
            onUp: () => { },    // 上报上层回调
            onEcho: () => { },  // 接收到消息后，回复ack
            onAck: () => { },   // 接收到Ack类型数据包回调
            onDone: () => { },  // 数据包接收完成回调
            onErrs: () => { },  // 数据包接收异常回调
            onTick: () => { },  // 在接收到数据包时的回调，可用于统计
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
            let { mtype, seq, peerInfo, payload, lo, rangesize, version, payloadbuffer } = this.decode(res.remoteInfo, res.message);
            if (mtype < ABROAD) {
                this.push(mtype, seq, peerInfo, payloadbuffer, rangesize, version, lo);
            } else {
                this.shift(mtype, seq, peerInfo, payloadbuffer);
            }
            this.onTick(mtype, 0);
        }

        // 接收方：处理来自网络的数据包 推送一个接收到的数据到接收队列，
        push(mtype, seq, peerInfo, payload, rangesize, version, lo) {
            switch (mtype) {
                case DOING:
                    this.stage(mtype, seq, peerInfo, payload, lo);
                    break;
                case DONED:
                    this.stage(mtype, seq, peerInfo, payload, lo);
                    break;
                case BEGIN:
                    this.begin(seq, peerInfo, payload, rangesize, version, lo);
                    break;
                case BDD:
                    this.bdd(seq, peerInfo, payload, rangesize, version, lo);
                    break;
                case BROAD:
                    this.onUp(seq, mtype, seq, peerInfo, payload, lo);
                    break;
                case MULTI:
                    this.onUp(seq, mtype, seq, peerInfo, payload, lo);
                    break;
                default:
                    this.onErrs("invalid type", seq, peerInfo, this);
                    break;
            }
        }

        // 发送方：处理来自网络的确认包 接收到ack数据包处理
        shift(mtype, seq, peerInfo, payload) {
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
        begin(isn, peerInfo, payload, rangesize, version, lo) {
            let node = {
                lo: lo,                     // node.lo 是否发生seq 回滚
                seq: isn,                  // node.seq 是isn
                peer: peerInfo,            // node.peer 是发送端信息
                L: isn + rangesize,        // node.L 理论数据包最大序号
                M: isn + rangesize,        // node.M 数据包最大序号
                P: isn,                    // node.P 当前收到的最大seq
                Q: new RecvBuffer(rangesize, isn), // node.Q 记录已经收到的数据，按seq的PQ
                T: BEGIN,
                V: version,                // node.T node.V 数据包类型及协议版本
                BF: Buffer.alloc(KUDP_RCVBUF),
                t: +new Date
            }
            // other 标记该queue的节点是否已经被操作完成，此处表示该节点对应的数据块是否已经接收完
            let curnode = this.queue.insert(node, { done: 0, stat: 0 });
            if (curnode && 1 === curnode.other.done) {
                curnode.other.stat++;
                LOG.warn("begin Repeat:", isn)
                return;
            }
            node._ = curnode;
            LOG.info("begin:", isn, node);
            // 用优先队列实现接收的数据包排序
            this.addSeqQueue(node, isn, [BEGIN, payload], lo);
            // 检测所有暂存区中已有的seq
            for (var seq in this.staging) {
                let seq_data = this.staging[seq];
                let mtype = seq_data[0], seq1 = seq_data[1], peer2 = seq_data[2],
                    payload3 = seq_data[3], lo4 = seq_data[4];
                if (peer2.address === peerInfo.address && peer2.port === peerInfo.port &&  // 必须是同一个ip:port
                    seq1 >= node.seq && seq1 < node.L) {
                    node['lo'] = lo4;
                    this.addSeqQueue(node, seq1, [mtype, payload3], lo4);
                    this.stage_size--;
                    delete this.staging[seq1];
                    this.checkQ(node);
                }
            }
            LOG.info("left stage:", this.staging);
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
                LOG.warn("queue isn: ", node['seq'], ' is done!')
                return;
            }
            let Q = node['Q'];
            let delta = node['M'] - node['P'];
            if (Q && (Q.size >= Recver.UPCD_SIZE || delta < Recver.UPCD_SIZE)) {
                let content_list = Q.pop();
                this.checkRcvBuf(node, content_list);
            }
            // 表示数据包已经接受完毕, 设置定时器释放可能没有释放queue
            if (this.isOver(node)) {
                node['_'].other.done = 1; // 当前数据块，接收数据已经
                node['t'] = +new Date - node['t'];
                let stat = { spend: node['t'] }
                this.onDone(node['seq'], node['T'], node['peer'], stat, this);
                /**
                 * TODO：释放接收器queue的时机
                 * 1. 过早的释放导致重复的seq无法处理
                 * 2. 太晚的释放导致过多的无效节点结构
                 * 参考tcp
                 */
                new timer({
                    onend: (args) => {
                        this.staging = [];
                        this.stage_size = 0;
                        let seq = (args || {}).seq;
                        this.queue.remove({ seq: seq });
                        this.timers[this.timerPrefix + seq].stop();
                        delete this.timers[this.timerPrefix + seq]; // 释放累计确认定时器
                        LOG.info("queue_remove: ", seq, this);
                    }
                }, { seq: node['seq'] }).start(ACK_TIMEOUT * 5);
            }
        }

        /**
         * 检测接收缓冲区是否已经满或者数据发送完毕
         */
        checkRcvBuf(node, content_list) {
            for (let i = 0, clen = content_list.length; i < clen; i++) {
                let content = content_list[i]
                let mtype = content[0], payload = content[1];
                let len = payload.length, offset = node['BF']._woffset, max = node['BF'].length;
                if (len + offset < max) {
                    node['BF'].writeBuffer(payload);
                } else { //  len + offset >= max
                    // LOG.debug("checkRcvBuf#:", node['BF']._woffset, node['BF'].slice(0, node['BF']._woffset).toString())
                    this.onUp(node['seq'], mtype, node['P'], node['peer'], node['BF'].readBuffer(0, node['BF']._woffset));
                    node['BF'].flush();
                    node['BF'].writeBuffer(payload);
                }
                if (++node['P'] >= node['M'] && DONED !== mtype) {
                    node['P'] = node['seq'] + (node['P'] - node['seq']) % (node['L'] - node['seq'])
                }
                if (this.isOver(node)) {
                    // LOG.debug("checkRcvBuf:", node['BF']._woffset, node['BF'].slice(0, node['BF']._woffset).toString())
                    this.onUp(node['seq'], mtype, node['P'], node['peer'], node['BF'].readBuffer(0, node['BF']._woffset));
                }
            }
            return true;
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
        stage(mtype, seq, peerInfo, payload, lo) {
            let curnode = this.location(seq);
            if (curnode) {
                // 接收到的数据seq，小于下一个需要的seq，表明重试数据seq
                if (curnode.data) {
                    curnode.data['lo'] = lo;
                    // 记录最大seq
                    if (DONED === mtype) {
                        curnode.data['M'] = +seq + 1;
                    }
                    if (0 === lo && curnode.data['P'] > seq)
                        curnode.other.stat++;
                    else
                        this.addSeqQueue(curnode.data, seq, [mtype, payload], lo);
                    this.checkQ(curnode.data);
                }
            } else {
                // 未找到BEGIN的数据包, 为了避免恶意攻击，限制最大缓存max_stage个无 BEGIN 数据包
                (this.stage_size++ <= this.max_stage) ?
                    this.staging[seq] = [mtype, seq, peerInfo, payload, lo] : null;
            }
        }

        // 添加收到seq 到 Q
        addSeqQueue(node, seq, content, lo) {
            try {
                node['Q'].push(seq, lo, content);
            } catch (e) {
                LOG.error(e)
            }
            // 添加seq定时器
            let mtype = content[0], ip = node['peer'].address, port = node['peer'].port;
            this.addSeqTimer(mtype, seq, ip, port);
        }

        /**
         * 原则：尽可能的保证对方收到ACK。
         * 1. 在2 * ACK_TIMEOUT，仍然没有收到对方的重复数据包，即可认为对方已经收到对应的seq的ack，即可释放对应seq
         * 2. 如果重新收到同一seq的数据包，说明对方没有收到ACK，此时需要重新启动同一个定时器，避免seq被释放
         */
        addSeqTimer(mtype, seq, ip, port) {
            let isn = seq, isnTimer = null;
            switch (mtype) {
                case BEGIN:
                    let Q = new seqTree(Recver.prefix, (a, b) => a - b);
                    Q.insert(seq, [mtype, ip, port, +new Date])
                    isnTimer = new timer({
                        onrestart: (...args) => { LOG.warn(args, 'timer restart') },
                        onend: (args) => { this.freeSeq(...args); }
                    }, [isn, Q]);
                    this.timers[this.timerPrefix + isn] = isnTimer;
                    isnTimer.start(ACK_ECHO_TIMEOUT);
                    break
                case DOING: case DONED:
                    let curnode = this.location(seq);
                    if (curnode && curnode.data) {
                        isnTimer = this.timers[this.timerPrefix + curnode.data['seq']];
                        if (isnTimer && isnTimer.args) {
                            Q = isnTimer.args[1];
                            Q.insert(seq, [mtype, ip, port, +new Date]);
                            if ("stopped" == isnTimer.status)
                                isnTimer.restart(ACK_ECHO_TIMEOUT);
                        }
                    }
                    break
                case BDD: case BROAD: case MULTI:
                    this.onEcho(ip, port, mtype, seq);
                    return
                default:
                    return
            }
        }

        // 释放接收队列中的已经确认的seq
        freeSeq(isn, Q) {
            let lastseq = null, lastother = null, delseq = [];
            // 发送待确认队列中的残余数据
            let fin = Q.each((seq, other) => {
                if (!lastseq) {
                    lastseq = seq;
                    lastother = other;
                } else {
                    // 判断所有连续的seq，做ack
                    if (lastseq + 1 !== seq)
                        return false
                    lastseq = seq;
                    lastother = other;
                }
                delseq.push(lastseq);
                return true;
            })
            // 删除累计确认过程中的所有seq
            for (let j = 0, len = delseq.length; j < len; j++) {
                Q.remove(delseq[j])
            }
            if (lastseq && lastother) {
                let [mtype, ip, port, stime] = lastother;
                this.onEcho(ip, port, mtype, lastseq, stime);
                let isnTimer = this.timers[this.timerPrefix + isn];
                if (isnTimer && "stopped" == isnTimer.status)
                    isnTimer.restart(ACK_ECHO_TIMEOUT);
            } else {
                LOG.warn("freeSeq:", isn, Q);
            }
            LOG.info("onEcho isn, fin, seq, other:", isn, fin, lastseq, lastother);
        }

        // 解析从外界收到的数据包
        decode(peer, buffer) {
            let pkg = Package.unpack(buffer);
            let mtype = pkg.header.Type(), seq = pkg.seq;
            peer.ipint = utils.Ip2Int(peer.address); // ip对应的数字
            return {
                mtype: mtype, seq: seq, peerInfo: (peer || {}), payload: pkg.payload, lo: pkg.lo,
                rangesize: pkg.rangesize, version: pkg.version, payloadbuffer: pkg.payloadbuffer
            }
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
                time: +new Date,
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
        // 添加ip信息
        addInfo(fd, option) {
            this.coonnset.addInfo(fd, option)
        }
        // 清除信息
        clearInfo(fd) {
            this.coonnset.setBit(fd, { time: +new Date });
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
            this.delta = 10;
            this.timers = {};               // 重试定时器
            this.stat = new Stat();         // 统计分析模块
            this.conn = new Connector();    // 虚拟连接器
            this.seqer = new SeqManage();   // seq 管理器
            this.queue = new seqTree(Sender.prefix, (a, b) => a.seq - b.seq); // 并发传输多个数据块的处理队列
            this.initOptions(options);
        }

        defaultOptions = {
            onSend: () => { },    // 准备发送数据
            onErrs: () => { },    // 重试次数过多异常
            onDone: () => { },    // 数据块发送完成
            rto: ACK_TIMEOUT, // 重试的超时时间
            repeat: 10,           // 发送超时最大次数，超过时将报错，回调onErrs
        }

        timerPrefix = Sender.prefix + "isn" + SEP;

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

        // 补充fd信息
        addInfo(fd, option) {
            this.conn.addInfo(fd, option)
        }

        _encoding(payload) {
            return Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
        }

        // 根据传输过程和payload调整数据包类型
        encode(fd, mtype, payload, max_size) {
            let seq = 0, overflow = false, lo = 0;
            let buff = this._encoding(payload);
            let psize = buff.length;
            if (buff && psize > max_size) {
                overflow = true;
                buff = buff.slice(0, max_size);
            }
            let size = buff.length;
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
                    [seq, lo] = this.seqer.get(fstat['isn']);
                    break;
                default:
                    throw Errors(EHEADERTYPE, "invalid type", type);
            }
            let pkg = { seq: seq, size: size, type: mtype, payload: buff, factor: FACTOR, lo: lo }
            let pack = new Package(mtype, 0, 0, 0, pkg);
            fstat.ip && this.addSeqQueue(mtype, seq, pkg.factor, fstat.ip, fstat.port, pack, fd);
            return { seq: seq, size: size, type: mtype, pack: pack }
        }

        encodeAck(mtype, seq, payload) {
            let buff = this._encoding(payload);
            let pkg = { seq: seq, size: buff.length, type: mtype, payload: buff }
            let pack = new Package(mtype, 0, 0, 1, pkg);
            return { seq: seq, size: buff.length, type: pack.header.Type(), pack: pack }
        }

        // 添加发送的数据seq到队列中
        addSeqQueue(mtype, seq, factor, ip, port, pack, fd) {
            switch (mtype) {
                case BEGIN:
                    let L = seq + factor * BASE_SECTION;
                    let Q = new seqTree(Sender.prefix, (a, b) => a - b);
                    Q.insert(seq, [mtype, ip, port, pack, +new Date])
                    this.queue.insert({ seq: seq, L: L, Q: Q, fd: fd }, { done: 0, stat: 0 });
                    return
                case BDD:
                    L = seq + 1;
                    Q = new seqTree(Sender.prefix, (a, b) => a - b);
                    Q.insert(seq, [mtype, ip, port, pack, +new Date])
                    this.queue.insert({ seq: seq, L: L, Q: Q, fd: fd }, { done: 0, stat: 0 });
                    return
                case DOING: case DONED:
                    break
                case BROAD: case MULTI:
                    return
                default:
                    return
            }
            let curnode = this.location(seq);
            if (curnode && curnode.data && curnode.data['Q'] instanceof seqTree) {
                curnode.data['Q'].insert(seq, [mtype, ip, port, pack, +new Date]);
                if (mtype === DONED) {
                    let isn = curnode.data['seq'];
                    let isnTimer = this.timers[this.timerPrefix + isn]
                    isnTimer && isnTimer.setArgs({ done: 1 });
                }
            } else {
                LOG.error("addSeqQueue empty");
            }
        }

        // 定时器超时重传
        retry(isn, ip, port) {
            let curnode = this.queue.find({ seq: isn });
            if (curnode && curnode.data && curnode.data['Q'] instanceof seqTree && 0 !== curnode.data['Q'].size) {
                // 防止死循环，导致无限重试
                let isnTimer = this.timers[this.timerPrefix + isn];
                if (isnTimer.repeat >= this.repeat) {
                    isnTimer.stop();
                    let peer = { address: ip, port: port };
                    this.onErrs(isn, peer, this);
                    return
                }
                // 发送待确认队列中的残余数据
                curnode.data['Q'].each((data, other) => {
                    // LOG.info("retry left seq:", data, other);
                    let [mtype, ip, port, pack, _] = other;
                    pack.setFlags(1, 0, 0); // 添加dup标志
                    this.onSend(mtype, ip, port, pack.buffer, 1);
                    other[4] = +new Date
                })
                if ("stopped" == isnTimer.status)
                    isnTimer.restart(this.rto);
            } else {
                LOG.error("retry invalid paramete!!!");
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
        free(seq, mtype, peerInfo) {
            let isn = null
            // 对应 addSeqQueue 的 case BROAD: case MULTI:
            if (mtype > AMULTI) {
                let curnode = this.location(seq);
                if (curnode && curnode.data && curnode.data['Q'] instanceof seqTree && 0 !== curnode.data['Q'].size) {
                    isn = curnode.data['seq'];
                    // 删除累计确认过程中的所有seq
                    let nodes = curnode.data['Q'].range(null, seq);
                    // LOG.info("free seq ok:", nodes);
                    for (let j = 0, len = nodes.length; j < len; j++) {
                        let node = curnode.data['Q'].remove(nodes[j].data);
                        this.seqer.del(nodes[j].data, isn);
                        node && this.calcRto(node);
                    }
                    // 尝试释放重试定时器
                    let isnTimer = this.timers[this.timerPrefix + isn]
                    if (isnTimer) {
                        // 队列为空，且已经收到结束数据包，释放定时器
                        if (0 === curnode.data['Q'].size && 1 === (isnTimer.args || {}).done) {
                            isnTimer.stop() && delete this.timers[this.timerPrefix + isn];
                            this.conn.clearInfo(curnode.data['fd']);
                            // 尝试释放isn
                            if (ABEGIN !== mtype && ADOING !== mtype) {
                                this.seqer.free(isn); // isn
                                this.queue.remove({ seq: isn });
                                this.onDone(isn, mtype, peerInfo, this.stat, this);
                            }
                        }
                    } else {
                        LOG.error("free isnTimer invalid", seq);
                    }
                } else {
                    LOG.error("free seq empty", seq);
                }
            } else {
                // TODO
                // 删除发送窗口中的分配的序号
                isn = isn || this.seqer.location(seq)
                if (isn >= 0) {
                    // 释放seq，BEGIN / DOING 是否中间的seq
                    if (ABEGIN === mtype || ADOING === mtype) {
                        this.seqer.del(seq, isn);
                    } else {
                        this.seqer.free(isn); // isn
                        this.onDone(isn, mtype, peerInfo, this.stat, this);
                    }
                }
            }
        }

        // 添加seq 重试定时器
        addSeqTimer(seq, type, ip, port, pack) {
            let isn = seq;
            let curnode = this.location(seq);
            if (curnode && curnode.data) {
                isn = curnode.data['seq'];
            } else {
                LOG.error("addSeqTimer empty");
                return
            }
            let isnTimer = this.timers[this.timerPrefix + isn];
            if (!isnTimer) {
                isnTimer = new timer({
                    onend: (args) => { this.retry(...args); },
                    onstop: (...args) => {
                        LOG.info("addSeqTimer onstop", ...args);
                    }
                }, [isn, ip, port]);
                isnTimer.setArgs({ done: 0, timeout: 0 });
                this.timers[this.timerPrefix + isn] = isnTimer;
                isnTimer.start(this.rto);
            }
        }

        // 计算rto  RFC1122 RFC6298 RFC2988
        calcRto(node) {
            let rtt = +new Date - node.other[4];
            let LBOUND = 100, UBOUND = 60000, rto = ACK_TIMEOUT;
            if (!this.srtt || this.srtt == 0) {
                this.srtt = rtt;
                this.rttvar = rtt >> 1;
            } else {
                let delta = rtt - this.srtt;
                if (delta < 0) {
                    delta = -delta;
                }
                this.rttvar = (3 * this.srtt + delta) >> 2;
                this.srtt = (7 * this.srtt + rtt) >> 3;
            }
            rto = this.srtt + 4 * this.rttvar;
            this.rto = Math.min(UBOUND, Math.max(LBOUND, rto))
            // LOG.info("calcRto", node, this.rto);
            return this.rto
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
            RecvBuffer.testRecvBuffer();
            for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
            this.bport = port;        // udp通信绑定的port，默认5328
            this.stat = new Stat();   // 统计分析模块
            this.sQueue = new Sender({
                onSend: this._onSend.bind(this),
                onErrs: this._onWerr.bind(this),
                onDone: this._onWdone.bind(this),
            })
            this.rQueue = new Recver({
                onUp: this._handleOnMessage.bind(this),
                onEcho: this._sendAck.bind(this),
                onAck: this._handleAckMessage.bind(this),
                onTick: this.recvStat.bind(this),
                onDone: this._onRdone.bind(this),
                onErrs: this._onRerr.bind(this),
            });
            this.initOptions(options);
            this._init();
        }

        defaultOptions = {
            onRead: () => { },   // 读取到网络上的数据回调
            onRerr: () => { },   // 接收传输异常时回调
            onRdone: () => { },  // 接收数据完成回调
            onStat: () => { },   // 数据分析统计回调
            onWrite: () => { },  // 向网络发送数据时回调
            onWerr: () => { },   // 发送异常时回调
            onWdone: () => { },  // 发送数据完成时回调
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

        // 发送完毕时回调
        _onWdone(seq, mtype, peer, stat, ctx) {
            this.onWdone(seq, mtype, peer, stat, ctx);
        }

        // 接收传输异常回调
        _onRerr(errType, seq, peer, ctx) {
            this.onRerr(errType, seq, peer, ctx);
        }

        // 发送传输异常回调
        _onWerr(seq, peer, ctx) {
            this.onWerr(seq, peer, ctx);
        }

        // 接收完毕时回调
        _onRdone(seq, mtype, peer, stat, ctx) {
            this.onRdone(seq, mtype, peer, stat, ctx);
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
            this.onStat('recv', this.stat);
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
            this.onStat('send', this.stat);
        }

        // 处理来自网络的确认包
        _handleAckMessage(mtype, seq, peerInfo, message) {
            this.sQueue.free(seq, mtype, peerInfo);
        }

        // 处理来自网络的数据包
        _handleOnMessage(isn, mtype, seq, peerInfo, payload) {
            this.onRead(isn, mtype, seq, peerInfo, payload);
        }

        // 由于数据包会再未收到对应ACK包时会重传，针对ACK包无需设置超时重传
        _sendAck(ip, port, mtype, seq) {
            LOG.info("sendAck:", seq, HeaderType[mtype]);
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
            this.onWrite(fd, payload, ip, port);
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

    exports.kudp = kudp;
    exports.Header = Header;
    exports.SeqManage = SeqManage;
    exports.Recver = Recver;

    exports.LAN_PACK_SIZE = LAN_PACK_SIZE
    exports.WAN_PACK_SIZE = WAN_PACK_SIZE
    exports.BROAD = BROAD  // 广播数据包
    exports.MULTI = MULTI  // 多播数据包
    exports.BEGIN = BEGIN  // 首个数据包
    exports.DOING = DOING  // 大型数据包中间数据包
    exports.DONED = DONED  // 结束数据包
    exports.BDD = BDD      // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
});