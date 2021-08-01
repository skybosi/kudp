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
 */
(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.kudp = factory()
}(this, function () {
    // base
    const ip = require('./common/ip')
    const utils = require('./common/utils')
    const BitSet = require('./common/BitSet')
    const timer = require('./common/timer')


    // kudp base
    const UdpBase = require('./UdpBase')
    const kupack = require('./kupack')
    const ConnectId = kupack.ConnectId
    const SeqManage = kupack.SeqManage
    const Package = kupack.Package

    // kudp net constant
    const BROADWAY = "255.255.255.255"
    const KUDPORT = 5328

    // kudp package constant
    const BROAD = kupack.BROAD         // 发送广播数据包
    const MULTI = kupack.MULTI         // 发送多播数据包
    const WSASK = kupack.WSASK         // 窗口的大小询问
    const WSANS = kupack.WSANS         // 窗口的大小回复通知
    const PINGS = kupack.PINGS         // 验证与维持对端是否仍然存活
    const RESET = kupack.RESET         // 重置发送过程，可以是task级别，也可以是connection级别
    const CLOSE = kupack.CLOSE         // 关闭连接，最终释放所有的资源，正在传输的将继续，但不再处理其他的新任务
    const BEGIN = kupack.BEGIN         // 发送开始数据包
    const DOING = kupack.DOING         // 大型数据包中间数据包
    const DONED = kupack.DONED         // 结束数据包
    const BDODO = kupack.BDODO         // 对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
    const DTACK = kupack.DTACK         // 针对数据包的确认
    const VERSION = kupack.VERSION     // 版本号
    const PROTONAME = kupack.PROTONAME
    const MTU = kupack.MTU
    const MSS = kupack.MSS
    const SEP = kupack.SEP
    const getCurTimeStamp = kupack.getCurTimeStamp

    // kudp error
    const EKUDPOK = 0
    const EINVALIDTASK = -1

    // kudp sender constant
    const SND_WND = 32
    const SND_BUF_FACTOR = 2
    const SND_FREQ = 10            // 发送定时器的刷新时间ms
    const SND_STATE_INIT = 0       // task初始化成功
    const SND_STATE_STASH = 1      // 数据暂存在 snd_que，未开始发送，理论上这个状态存在的时间很短
    const SND_STATE_SENDING = 2    // 数据处于发送中
    const SND_STATE_PENDING = 3    // 数据发送过程，因为 snd_buf满 或 rmt_wnd = 0，无法继续发送，该状态可能变成 SND_STATE_SENDING 或 SND_STATE_TIMEOUT 或 SND_STATE_ERROR
    const SND_STATE_PAUSE = 4      // 应用层主动暂停发送任务，应用层数据还未发送万，但是snd_que 和 snd_buf如果有数据，继续发送至完
    const SND_STATE_TIMEOUT = 5    // 因为发送到对端，超过一定时间为响应或超过一定的次数未响应，一般发送网络断开或恶意攻击
    const SND_STATE_ERROR = 5      // 判断发送通道完全无法发送数据，一般从SND_STATE_TIMEOUT演变而来，该状态维持2个RTT，将自动关闭进入 SND_STATE_CLOSE
    const SND_STATE_DONE = 7       // 数据发送完毕，必须是对端的ack已经到达
    const SND_STATE_RESET = 8      // 应用层主动重置数据发送流程，改动作将清空 snd_que，如果是PCF = 0，将发送完所有snd_buf的数据，如果是PCF = 1，将清空所有snd_buf的数据，接收端将清空已经接收到的部分数据
    const SND_STATE_CLOSE = 9      // task关闭，将不再接受应用层数据

    // kudp recver constant
    const RCV_WND = 32
    const RCV_BUF_FACTOR = 2
    const RCV_BUF_WND_THRESHOLD = RCV_WND * RCV_BUF_FACTOR


    /*************************************************************** Fd ******************************************************************/
    const FD_BROAD = 3 // 广播占用fd
    const FD_MULTI = 4 // 多播占用fd
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

        /**
         * 初始化几个固定的bit位的信息
         */
        init() {
            this.setBit(FD_BROAD, { fd: FD_BROAD, mtyp: BROAD, address: BROADWAY, port: KUDPORT, time: +new Date, });
            this.setBit(FD_MULTI, { fd: FD_MULTI, mtyp: MULTI, port: KUDPORT, time: +new Date, });
        }

        /**
         * 获取一个合适fd，同时绑定相关信息
         * @param {*} info
         */
        New(info) {
            let fd = this.getfd();
            info.fd = fd;
            this.setBit(fd, info);
            return fd;
        }

        /**
         * 为一个已经设置过数据的fd添加属性。
         * @param {*} fd
         * @param {*} info
         */
        addInfo(fd, info) {
            this.fdinfo[fd] = Object.assign((this.fdinfo[fd] || {}), info)
            return this.fdinfo[fd]
        }

        /**
         * 获取最小一个0的位置作为下一个可分配的fd
         */
        getfd() {
            let fd = this.fdset.ffz();
            if (fd < 0) {
                throw Errors(EBADFD, "bad fd");
            }
            this.fdset.set(fd);
            return fd
        }

        /**
         * 设置bit附属信息
         * @param {*} fd
         * @param {*} info
         */
        setBit(fd, info) {
            this.fdinfo[fd] = info;
        }

        /**
         * 释放一个fd，同时回收bit
         * @param {*} fd
         */
        close(fd) {
            this.fdset.unset(fd);
            var info = this.info(fd)
            delete this.fdinfo[fd];
            return info
        }

        /**
         * 清除信息, 方便复用
         * @param {*} fd
         */
        clear(fd) {
            var info = this.info(fd)
            this.fdinfo[fd] = { time: +new Date }
            return info
        }
        /**
         * 获取bit对应的附属属性
         * @param {*} fd
         */
        info(fd) {
            return this.fdinfo[fd];
        }

        static testFd() {
            var fdset = new Fd("0,99");
            let i = 0
            while (i++ < 1000) {
                fdset.New({ [i]: i });
            }
            i = fdset.fdset.ffz();
            while (i-- >= 0) {
                fdset.close(i);
            }
        }
    }

    /************************************************************ Connector **************************************************************/
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
            this.fds = new Fd();
            this.connids = {}
        }

        /**
         * 新建一次新的传输过程，分配一个唯一的fd
         * @param {*} option
         */
        create(option = {}) {
            option.connid = this.getConnId(option.cf)
            option.cid = option.connid.cid
            option.endpoint = [option.address, option.port].join(SEP)
            var fd = this.fds.New(option);
            this.connids[option.cid] = this.fds.info(fd);         // cid 定位对端
            this.connids[option.endpoint] = this.fds.info(fd);    // endpoint 定位对端
            return fd;
        }

        /**
         * 释放对应的fd
         * @param {*} fd
         */
        destroy(fd) {
            var info = this.fds.close(fd);
            delete this.connids[info.cid];
        }

        /**
         * 获取一个可用的cid
         * @param {*} cf
         * @returns
         */
        getConnId(cf) {
            var try_count = 0
            while (true && try_count < 256) {
                let connid = new ConnectId(cf)
                if (this.connids[connid.cid] && 0 != cf) {
                    connid = new ConnectId(cf)
                    try_count++
                }
                return connid
            }
            throw Errors(EBADFD, "bad connect id");
        }

        /**
         * 通过fd获取对应的信息
         * @param {*} fd
         */
        fstat(fd) {
            return this.fds.info(fd);
        }

        /**
         * 通过cid 或 endpoint 获取对应的连接信息
         * @param {*} cid
         * @param {*} address
         * @param {*} port
         * @returns
         */
        fconn(cid, address, port) {
            var endpoint = [address, port].join(SEP)
            if ("0x" != cid) {
                return this.connids[cid] || this.connids[endpoint]
            }
            return this.connids[endpoint] || this.connids[cid]
        }

        /**
         * 添加额外信息
         * @param {*} fd
         * @param {*} option
         */
        addInfo(fd, option) {
            var info = this.fds.addInfo(fd, option)
            this.connids[info.cid] = Object.assign((this.connids[info.cid] || {}), option)
        }

        /**
         * 清除信息
         * @param {*} fd
         */
        clearInfo(fd) {
            var info = this.fds.clear(fd);
            this.connids[info.cid] = {}
        }
    }

    /************************************************************** Sender ***************************************************************/
    class Sender {
        constructor(options = {}) {
            this.task = {}
            this.seqer = new SeqManage()   // seq 管理器
            this.kudp_output = options.output
            this.error = options.error
            this.conn = options.conn
        }

        /**
         * 计算一个task唯一标志，同一个连接tn不重复，不同连接tn可能会重复
         * @param {int} fd connect 返回的连接号
         * @param {int} tn seqer 返回的任务号
         * @returns fdtn 连接任务号
         */
        _fdtn(fd, tn) {
            return fd + SEP + tn
        }

        /**
         * fdtn 的反向操作
         * @param {*} fdtn Fdtn计算的数据
         * @returns {fd, tn} 连接号 任务号
         */
        _tnfd(fdtn) {
            var [fd, tn] = fdtn.split(SEP)
            return { fd, tn }
        }

        /**
         * 获取某个连接的task的上下文信息
         * @param {*} fdtn
         * @returns
         */
        _task_ctx(fd, tn) {
            if (this.task[fd] && this.task[fd][tn]) {
                return this.task[fd][tn]
            }
            return null
        }

        /**
         * 获取当前可用的发送窗口大小
         * @param {*} task_ctx
         * @returns
         */
        _snd_wnd_now(task_ctx) {
            var cwnd = Math.min(task_ctx.snd_wnd, task_ctx.rmt_wnd)
            return cwnd
        }

        /**
         * 将数据打包
         * @param {*} task_ctx
         * @param {*} buf
         * @param {*} len
         * @param {*} flag
         */
        _snd_data_pack(task_ctx, buf, len, flag) {
            var { tn, cf, isn, sndcnt, snd_state, connid } = task_ctx
            var kudpack = null
            var ctx = { payload: buf }
            var seq = isn
            // 判断当前数据包是否是该task的第一个数据包
            if (sndcnt == 0 && snd_state == SND_STATE_INIT) {
                // 判断当前数据包是否小于1个MSS
                if (len <= MSS) {
                    kudpack = new Package(BDODO, flag, cf, tn, seq, connid, ctx)
                } else {
                    kudpack = new Package(BEGIN, flag, cf, tn, seq, connid, ctx)
                }
            } else {
                seq = this.seqer.next(tn)
                // 判断当前数据包是否小于1个MSS
                if (len <= MSS) {
                    kudpack = new Package(DONED, flag, cf, tn, seq, connid, ctx)
                } else {
                    kudpack = new Package(DOING, flag, cf, tn, seq, connid, ctx)
                }
            }
            return { seq, kudpack }
        }

        /**
         * 添加到snd_que
         * @param {*} task_ctx
         * @param {*} pack
         * @returns
         */
        _add_snd_que(task_ctx, seq, kupack) {
            if (task_ctx.nsnd_que >= task_ctx.snd_que_siz) {
                return -1
            }
            var { fdtn, fd, tn } = task_ctx
            task_ctx.snd_que[seq] = kupack
            task_ctx.nsnd_que++
            // 更新task状态
            if (task_ctx.snd_state <= SND_STATE_STASH) {
                task_ctx.snd_state = SND_STATE_STASH
                // snd_buf 有数据时定时驱动发送到网络中
                if (!task_ctx.snd_timer) {
                    task_ctx.snd_timer = new timer({
                        onend: (args) => {
                            this._update_snd_buf(...args)
                        },
                        onstop: (...args) => { console.info("timer onstop:", ...args) }
                    }, [fd, tn])
                    task_ctx.snd_timer.start(SND_FREQ)
                }
            }
            return 0
        }

        /**
         * 发送定时器超时，将调用kudp_output将数据发送到网络
         * @param {*} fd
         * @param {*} tn
         */
        _update_snd_buf(fd, tn) {
            var task_ctx = this._task_ctx(fd, tn)
            // 当前的发送窗口
            var snd_wnd_now = this._snd_wnd_now(task_ctx)
            var { address, port, snd_una, snd_nxt } = task_ctx
            var snd_cursor = snd_wnd_now + snd_una
            // 将snd_que中的数据移到snd_buf中，并kudp_output发送出去
            while (snd_cursor > snd_nxt) {
                if (task_ctx.nsnd_que <= 0) {
                    break
                }
                var kupack = task_ctx.snd_que[snd_nxt]
                task_ctx.snd_buf[snd_nxt] = kupack
                this.kudp_output(address, port, kupack.buffer)
                delete task_ctx.snd_que[snd_nxt]
                task_ctx.nsnd_que--
                snd_nxt++
            }
            // 如果发送位置未移动，说明已经有些发送阻塞
            if (task_ctx.snd_nxt == snd_nxt) {
                task_ctx.snd_state = SND_STATE_PENDING
            } else {
                task_ctx.snd_state = SND_STATE_SENDING
                // 如果已经初始化了发送定时器，将再次重启
                if (task_ctx.snd_timer) {
                    task_ctx.snd_timer.restart(SND_FREQ)
                }
            }
            task_ctx.snd_nxt = snd_nxt
        }

        /**
         * 在一个虚拟连接创建一个task
         * @param {*} fd
         * @returns fdtn
         */
        create(fd, swnd, rwnd) {
            var { cf, connid, cid, address, port } = this.conn.fstat(fd)
            var { tn, seq } = this.seqer.malloc()  // 创建任务
            var fdtn = this._fdtn(fd, tn)
            var snd_wnd = swnd || SND_WND
            var rcv_wnd = rwnd || RCV_WND
            var snd_que_siz = snd_wnd * SND_BUF_FACTOR
            var snd_buf_wnd = snd_wnd + snd_que_siz
            this.task[fd] = this.task[fd] || {}
            this.task[fd][tn] = {
                fd, tn, cf, connid, cid, isn: seq, fdtn, address, port,
                sndcnt: 0,                 // 已经发送的数据包个数
                snd_que: {},               // 发送缓冲区（跟用户层接触的数据包）
                nsnd_que: 0,               // 发送缓冲区数据包数量
                snd_buf: {},               // 发送窗口（协议缓存的数据包）
                nsnd_buf: 0,               // 发送窗口数据包数量
                snd_una: seq,              // 最大未ack的序号
                snd_nxt: seq,              // 待发送的包序号
                snd_wnd: snd_wnd,          // 发送窗口大小
                rmt_wnd: rcv_wnd,          // 远端接收窗口大小
                snd_que_siz: snd_que_siz,  // 发送缓冲 snd_que 的大小
                snd_buf_wnd: snd_buf_wnd,  // 最大发送端缓存的限制 snd_buf + snd_que 总和
                snd_state: SND_STATE_INIT, // 发送状态值
                snd_timer: null,           // 发送数据定时器
            }
            return { fdtn, tn, isn: seq }
        }

        /**
         * 检测虚拟连接中task的堆积的数据包个数
         * @param {*} fdtn
         * @returns
         */
        kudp_waitsend(fdtn) {
            var { fd, tn } = this._tnfd(fdtn)
            var task_ctx = this._task_ctx(fd, tn)
            if (!utils.isNull(task_ctx)) {
                return task_ctx.nsnd_buf + task_ctx.nsnd_que
            }
            return -1
        }

        /**
         * 检测虚拟连接中task是否可以继续接受发送数据
         * @param {*} fdtn
         * @returns bool
         */
        kudp_cansend(fdtn) {
            var { fd, tn } = this._tnfd(fdtn)
            var task_ctx = this._task_ctx(fd, tn)
            if (!utils.isNull(task_ctx)) {
                return (task_ctx.nsnd_buf + task_ctx.nsnd_que) < task_ctx.snd_buf_wnd
            }
            return false
        }

        /**
         * 将要发送的数据写入kudp内部
         * @param {*} fdtn
         * @param {*} buf
         * @param {*} len
         * @param {*} flag
         * @returns
         *  0: 成功
         *  -1: 无效fdtn，获取不到_task_ctx
         *  -2: 超过了kudp当前task的最大缓存
         *  -3:
         */
        kudp_send(fdtn, buf, len, flag) {
            var { fd, tn } = this._tnfd(fdtn)
            var task_ctx = this._task_ctx(fd, tn)
            if (!utils.isNull(task_ctx)) {
                var nbuf = task_ctx.nsnd_buf + task_ctx.nsnd_que;
                // 没有超过最大发送端缓存的限制 snd_buf + snd_que 总和
                if (nbuf < task_ctx.snd_buf_wnd) {
                    var { seq, kudpack } = this._snd_data_pack(task_ctx, buf, len, flag)
                    return this._add_snd_que(task_ctx, seq, kudpack)
                } else {
                    return -2
                }
            }
            this.error(fd, fdtn, EINVALIDTASK, "invalid task")
            return -1
        }

        /**
         * 发送广播消息
         * @param {*} options 记录广播内容中的kind编码表及信息
         */
        kudp_broadcast(options) {
            var { address, port } = options
            var pcf = (options.kind && Object.keys(options.kind).length === 0) ? 0 : 1
            var kudpack = new Package(BROAD, pcf, 0, null, null, null, options)
            this.kudp_output(address, port, kudpack.buffer)
        }

        /**
         *
         * @param {*} fdtn
         * @param {*} ts
         * @param {*} delta
         * @param {*} rmt_wnd
         */
        kudp_update_rmtwnd(fdtn, ts, delta, rmt_wnd) {

        }
    }

    /************************************************************** Recver ***************************************************************/
    class Recver {
        constructor(options = {}) {
            this.task = {}
            this.kudp_recv = options.input
            this.kudp_output = options.output
            this.error = options.error
            this.conn = options.conn
        }

        /**
         *
         * @param {*} cid
         * @param {*} address
         * @param {*} port
         * @param {*} tn
         */
        kudp_rwnd(cid, address, port, tn) {
            return RCV_WND
        }
        /**
         *
         * @param {*} address
         * @param {*} port
         * @param {*} buffer
         */
        kudp_input(address, port, buffer) {
            var rcv_ts = getCurTimeStamp()
            var kudpack = new Package.unpack(buffer)
            if (!kudpack) {
                return -1
            }
            var { version, mtype, pcf, cf, cid, connid, header, body } = kudpack
            if (version != VERSION ||                          // 不合法的版本号
                !header.validType(mtype) ||                   // 无效的数据包类型
                !header.validPcf(pcf)) {                      // 无效的pcf
                return -2
            }
            var { ts, tn, seq, ctx } = body                    // 数据包体
            var conninfo = this.conn.fconn(cid, address, port) // 获取当前数据包对应可能存在的连接信息
            var recvId = [cid, tn].join(SEP)                   // 接收端生成一个task的唯一标识
            console.log(kudpack.toHex(), body)
            console.log(header.toHex(), conninfo)
            var rwnd = null, ackpack = null
            // 处理不同数据包类型
            switch (mtype) {
                case BROAD:
                    break;
                case MULTI:
                    break;
                case WSASK:
                    break;
                case WSANS:
                    break;
                case PINGS:
                    break;
                case RESET:
                    break;
                case CLOSE:
                    break;
                case BEGIN: case DOING: case DONED:
                    rwnd = this.kudp_rwnd(cid, address, port, tn)
                    var ctx = { rcv_ts, rwnd }
                    ackpack = new Package(DTACK, 0, cf, tn, seq, connid, ctx)
                    break;
                case BDODO:
                    rwnd = this.kudp_rwnd(cid, address, port, tn)
                    var ctx = { rcv_ts, rwnd }
                    ackpack = new Package(DTACK, 0, cf, tn, seq, connid, ctx)
                    break;
                case DTACK:
                    break;
            }
            // 回复ack包
            if (ackpack) {
                this.kudp_output(address, port, ackpack.buffer)
            }
        }

        kudp_recv(fdtn, buf, len, flag) {
        }
    }

    /*************************************************************** kudp ****************************************************************/
    /**
     *
     * 数据驱动两种模式
     *   1. 正常的发送数据流，从发送端到接收端
     *      - send 调用检测kudp协议层是否超过最大缓冲区 snd_buf + snd_que 总和，如果超过不再发送, 建议用 kudp_cansend 检测
     *      - kudp_send 接收send的数据，打包写入snd_que，驱动下检测snd_buf是否有空间 (snd_una + cwnd) - snd_nxt > 0，如果满足，驱动从snd_que移动到snd_buf，否则存放在snd_que
     *      - 如果收到对端的 DACK 中的seq, una, sack/snack, rmt_wnd 驱动更新 snd_una, cwnd, snd_nxt, nunack[数据包未ack次数], 进而驱动从snd_que移动到snd_buf，以及是否触发快重传
     *      - 如果超时未收到 DACK 进入下面的模式2
     *   2. 定时器在超时的时候驱动
     *      - 检测 snd_una 与 snd_nxt 之间未被确认的数据包，触发重传，同时清空每个数据包的 nunack
     *      - 检测 snd_que 是否还有数据，且 snd_buf 是否有空间 (snd_una + cwnd) - snd_nxt > 0，如果满足，驱动从snd_que移动到snd_buf
     *
     * 创建连接通道示意：
     *
     *                  open
     *   userA ───────────────────+
     *     |                      |   创建一个连接
     *     |                      V
     *     | create    ──────────────────────────────────────────────────────────────────────────────────────────────────
     *     ├────────>    send                                        TN 1                                         recv
     *     | create    ──────────────────────────────────────────────────────────────────────────────────────────────────
     *     ├────────>    send                                        TN ...                                       recv       userB
     *     | create    ──────────────────────────────────────────────────────────────────────────────────────────────────
     *     └────────>    send                                        TN n                                         recv
     *                 ──────────────────────────────────────────────────────────────────────────────────────────────────
     *
     * 数据传输示意：
     *
     *    userA            |   kudp协议层
     *     |               |
     *     |               |                          +--------------------------------------+
     *     V               |                          |                                      |   kudp_output
     *    send   --->-->   |   kudp_send    --->-->   |   snd_que    --->-->    snd_buf      |  ----->-------+
     *                     |                          |                                      |               |
     *                     |                          +--------------------------------------+               |
      *                    |                                   ^       ^       ^       ^                     |
     *                     |                                   |   T   |   T   |   T   |     Data stream     |
     *                     |                                   |   N   |   N   |   N   |     ACK stream      V  retransmission timer
     *                     |                                   v   1   v  ...  v   n   v                     |
     *                     |                          +--------------------------------------+               |
     *                     |                          |                                      |               |
     *    recv   <--<---   |   kudp_recv    <--<---   |   rcv_que    <--<---    rcv_buf      |  <----<-------+
     *     |               |                          |                                      |   kudp_input
     *     |               |                          +--------------------------------------+
     *     V               |
     *    userB            |
     *
     * 几个概念:
     *   snd_buf: 发送窗口，通过滑动窗口控制和保证发送质量与速率
     *   snd_que: 发送缓冲区，用于缓冲 snd_buf 来自应用层的发送压力，对应用层透明
     *   rcv_buf: 接收窗口，用于确保有序上交 rcv_que，实现ack回传记录的依据
     *   rcv_que: 接收缓冲区，保存的是来自 rcv_buf 上报的有序数据，供应用层获取
     *
     * kudp内部几个核心方法:
     *   发送方:
     *     kudp_send: 接收来自应用层的 send 数据发送，打包写入snd_que
     *     kudp_output: 从 snd_buf 获取需要发送到网络的数据包
     *   接收方:
     *     kudp_input: 从网络中接收到kudp的数据包，做拆包处理获取到原数据及控制信息，写入 rcv_buf
     *     kudp_recv: 驱动从 rcv_buf 中获取有效的数据，从 rcv_buf 搬运到 rcv_que ，释放 rcv_buf 的有效空间，提交给应用层 recv 调用
     *
     */
    class kudp extends UdpBase {
        constructor(port) {
            super(port);
            // 虚拟连接器
            this.conn = new Connector()
            // 发送器
            this.sender = new Sender({
                output: this.write.bind(this),
                error: this.error.bind(this),
                conn: this.conn
            })
            // 接收器
            this.recver = new Recver({
                output: this.write.bind(this),
                input: this.recv.bind(this),
                error: this.error.bind(this),
                conn: this.conn
            })
        }

        /**
         * 接收来自网络的数据包
         * @param {*} address 接收到数据远程连接的 `IP` 地址
         * @param {*} port 接收到数据远程连接的 `port` 地址
         * @param {*} buffer 数据负载
         */
        _onMessageHandler(address, port, buffer) {
            this.recver.kudp_input(address, port, buffer)
        }

        /**
         * 创建kudp连接
         * @param {string} address 要创建连接的 `IP` 地址
         * @param {int} port 要创建连接的 `port` 地址, 默认5328
         * @param {int} flag 连接模式参数, 可选值如下
         *        - 0: 不生成连接id, 用于稳定局域网
         *        - 1: 生成1字节的cid, 用于小型局域网
         *        - 2: 生成4字节的cid, 用于大型局域网
         *        - 3: 生成8字节的cid, 用于广域网
         *
         * 返回: {int} 连接文件描述符
         */
        open(address, port, flag) {
            var option = {
                cf: flag,
                port: port,
                address: address,
            }
            return this.conn.create(option);  // 创建一个虚拟连接器
        }

        /**
         * 关闭kudp连接
         * @param {*} fd 由`open`创建出来的文件描述符
         *
         * 返回: 空
         */
        close(fd) {
            return this.conn.destroy(fd);     // 关闭一个虚拟连接器
        }

        /**
         * 在一个kudp连接创建一个发送通道task
         * @param {*} fd 由`open`创建出来的文件描述符
         * @param {*} snd_wnd 发送串口
         */
        create(fd, snd_wnd, rcv_wnd) {
            var { fdtn, tn, isn } = this.sender.create(fd, snd_wnd, rcv_wnd)
            this.conn.addInfo(fd, { fdtn, tn, isn })
            return fdtn;
        }

        /**
         * 向一个kudp连接发送数据包
         * @param {string} fdtn 由`create`创建出来的`fd task number`
         * @param {string|Buffer|ArrayBuffer} buf 待发送的数据
         * @param {int} len 待发送的数据长度,单位字节
         * @param {*} flag
         *
         * 返回: 隐式创建的 fdtn, 表示当前唯一 `fd task number`
         */
        send(fdtn, buf, len, flag) {
            return this.sender.kudp_send(fdtn, buf, len, flag)
        }

        /**
         * 从一个kudp连接收数据包, 回调的方式
         * @param {string} fdtn 由`create`创建出来的`fd task number`
         * @param {Buffer} buf 接收到的数据
         * @param {int} len 接收到的数据, 单位字节
         * @param {*} flag
         *
         * 返回: 隐式创建的 fdtn, 表示当前唯一 `fd task number`
         */
        recv(fdtn, buf, len, flag) {
            return this.recver.kudp_recv(fdtn, buf, len, flag)
        }

        /**
         * 从一个kudp连接返回异常信息, 回调的方式
         * @param {int} fd 由`open`创建出来的文件描述符
         * @param {int} tn 由`create`创建出来的`fd task number` 0 表示连接级别
         * @param {int} code 异常错误码
         * @param {string} msg 异常信息
         *
         * 返回: 隐式创建的 tn, 表示当前唯一 `fd task number`
         */
        error(fd, fdtn, code, msg) {

        }

        /**
         * 重置一个的发送任务
         * @param {int} fd 由`open`创建出来的文件描述符
         * @param {int} tn send|recv|error 返回的 tn, 表示当前唯一 `fd task number`
         * @param {*} flag
         *        - 0: 表示暂停该task的数据传输
         *        - 1: 表示终止该task的数据传输
         *        - 2: 表示撤回该task的已经传输的数据
         *
         * 返回: <bool> 状态
         */
        reset(fd, fdtn, flag) {

        }

        /**
         * 局域网内，广播消息
         * @param {*} option 一些需要广播附带的信息，用于搭建组网的基本信息
         */
        broadcast(options = {}) {
            var { address, port } = this.conn.fstat(FD_BROAD)
            options.address = address
            options.port = port
            options.kind = [{ kind: 0, value: "hello BROAD" }]
            this.sender.kudp_broadcast(options)
        }
    }

    return kudp;
}))