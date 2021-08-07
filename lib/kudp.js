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
    const CTACK = kupack.CTACK         // 控制流的数据包ACK

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
    const SND_NAME = "snd"
    const SND_WND = 32
    const SND_BUF_FACTOR = 2
    const SND_FREQ = 10            // 发送定时器的刷新时间ms
    const SND_INTERVAL = 100       // 发送rto计算时的interval
    const SND_RTO_MIN = 100        // 发送时正常情况下最小 rto
    const SND_RTO_DEF = 200        // 初始化rto
    const SND_RTO_MAX = 60000      // 发送时最大 rto
    const SND_FASTACK_LIMIT = 5    // max times to trigger fastack
    const SND_ALPHA = 0.125        // 计算加权平均往返时间系数
    const SND_BETA = 0.25          // 计算rtt偏差的加权平均系数
    const SND_0WND_ASK_FREQ = 100  // 0窗口定时器的刷新时间ms

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
    const RCV_NAME = "rcv"
    const RCV_WND = 64
    const RCV_BUF_FACTOR = 2
    const RCV_BUF_WND_THRESHOLD = RCV_WND * RCV_BUF_FACTOR
    const RCV_STATE_INIT = 10



    const _ibound_ = (lower, middle, upper) => {
        return Math.min(Math.max(lower, middle), upper)
    }

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
         * @param {*} fd 由`open`创建出来的文件描述符
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
         * @param {*} fd 由`open`创建出来的文件描述符
         * @param {*} info
         */
        setBit(fd, info) {
            this.fdinfo[fd] = info;
        }

        /**
         * 释放一个fd，同时回收bit
         * @param {*} fd 由`open`创建出来的文件描述符
         */
        close(fd) {
            this.fdset.unset(fd);
            var info = this.info(fd)
            delete this.fdinfo[fd];
            return info
        }

        /**
         * 清除信息, 方便复用
         * @param {*} fd 由`open`创建出来的文件描述符
         */
        clear(fd) {
            var info = this.info(fd)
            this.fdinfo[fd] = { time: +new Date }
            return info
        }
        /**
         * 获取bit对应的附属属性
         * @param {*} fd 由`open`创建出来的文件描述符
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
            this.task = {}
        }

        /**
         * 新建一个连接上下文，如果没有初始化
         * @param {*} oid 
         * @param {*} source 
         * @param {*} ctx 
         */
        newTask(oid, source, ctx) {
            if (this.task[oid] && this.task[oid][source]) {
                for (var key in ctx) {
                    this.task[oid][source][key] = ctx[key]
                }
            }
            this.task[oid] = this.task[oid] || {}
            this.task[oid][source] = ctx
        }

        /**
         * 新建一次新的传输过程，分配一个唯一的fd
         * @param {*} options
         */
        connect(options = {}) {
            options.connid = this.getConnId(options.cf)
            options.cid = options.connid.cid
            options.endpoint = [options.address, options.port].join(SEP)
            var fd = this.fds.New(options);
            this.connids[options.cid] = this.fds.info(fd);         // cid 定位对端
            this.connids[options.endpoint] = this.fds.info(fd);    // endpoint 定位对端
            return fd;
        }

        /**
         * 释放对应的fd
         * @param {*} fd 由`open`创建出来的文件描述符
         */
        disconnect(fd) {
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
         * @param {*} fd 由`open`创建出来的文件描述符
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
         * @param {*} fd 由`open`创建出来的文件描述符
         * @param {*} options
         */
        addInfo(fd, options) {
            var info = this.fds.addInfo(fd, options)
            this.connids[info.cid] = Object.assign((this.connids[info.cid] || {}), options)
        }

        /**
         * 清除信息
         * @param {*} fd 由`open`创建出来的文件描述符
         */
        clearInfo(fd) {
            var info = this.fds.clear(fd);
            this.connids[info.cid] = {}
        }
    }

    /************************************************************** Sender ***************************************************************/
    class Sender {
        constructor(options = {}) {
            this.seqer = new SeqManage()   // seq 管理器
            this.kudp_output = options.output
            this.error = options.error
            this.conn = options.conn
            this.snd_task = this.conn["task"]
            this._id = options._id
        }

        /**
         * 初始化oid
         * @param {*} cid 
         * @param {*} tn 
         * @param {*} address 
         * @param {*} port 
         * @returns 
         */
        _initoid(cid, tn, address, port) {
            var oid = [address, port, tn].join(SEP)
            if (cid && cid != "0x") {
                oid = [cid, tn].join(SEP)
            }
            return oid
        }

        /**
         * 获取某个连接的task的上下文信息
         * @param {*} fdtn 由`create`创建出来的`fd task number`
         * @returns
         */
        _snd_task_ctx(fdtn) {
            if (this.snd_task[fdtn] && this.snd_task[fdtn][SND_NAME]) {
                return this.snd_task[fdtn][SND_NAME]
            }
            return null
        }

        /**
         * 获取当前可用的发送窗口大小
         * @param {*} task_ctx task 上下文
         * @returns
         */
        _snd_wnd_now(task_ctx) {
            var cwnd = Math.min(task_ctx.snd_wnd, task_ctx.rmt_wnd)
            return cwnd
        }

        /**
         * 将数据打包
         * @param {*} task_ctx task 上下文
         * @param {*} buf 待发送的数据buf
         * @param {*} len 待发送的数据len
         * @param {*} flag
         */
        _snd_data_pack(task_ctx, buf, len, flag) {
            var { tn, cf, snd_nxt, sndcnt, snd_state, connid } = task_ctx
            var pack_ctx = null
            var seq = snd_nxt
            // 判断当前数据包是否是该task的第一个数据包
            if (sndcnt == 0 && snd_state == SND_STATE_INIT) {
                // 判断当前数据包是否小于1个MSS
                var mtype = (len <= MSS) ? BDODO : BEGIN
                pack_ctx = { mtype, flag, cf, tn, seq, connid, buf }
            } else {
                // 判断当前数据包是否小于1个MSS
                var mtype = (len <= MSS) ? DONED : DOING
                pack_ctx = { mtype, flag, cf, tn, seq, connid, buf }
                // 更新snd_nxt
                task_ctx.snd_nxt = this.seqer.next(tn)
            }
            return { seq, pack_ctx }
        }

        /**
         * 添加到snd_que
         * @param {*} task_ctx task 上下文
         * @param {*} pack
         * @returns
         */
        _add_snd_que(task_ctx, seq, pack_ctx) {
            if (task_ctx.nsnd_que >= task_ctx.snd_que_siz) {
                return -1
            }
            var { fdtn } = task_ctx
            task_ctx.snd_que[seq] = pack_ctx
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
                    }, [fdtn])
                    task_ctx.snd_timer.start(SND_FREQ)
                }
            }
            return 0
        }

        /**
         * 发送定时器超时，将调用kudp_output将数据发送到网络
         * @param {*} fdtn connect 返回的连接号
         */
        _update_snd_buf(fdtn) {
            var task_ctx = this._snd_task_ctx(fdtn)
            var { tn } = task_ctx
            // 当前的发送窗口
            var snd_wnd_now = this._snd_wnd_now(task_ctx)
            var { address, port, snd_una, snd_nxt } = task_ctx
            var snd_cursor = snd_wnd_now + snd_una
            // 将snd_que中的数据移到snd_buf中，并kudp_output发送出去
            while (snd_cursor > snd_nxt) {
                if (task_ctx.nsnd_que <= 0) {
                    break
                }
                task_ctx.snd_buf[snd_nxt] = task_ctx.snd_que[snd_nxt]
                task_ctx.snd_buf[snd_nxt]["xmit"] = 0
                task_ctx.snd_buf[snd_nxt]["rto"] = task_ctx.rx_rto
                task_ctx.snd_buf[snd_nxt]["fastack"] = 0
                delete task_ctx.snd_que[snd_nxt]
                task_ctx.nsnd_que--
                snd_nxt++
            }

            var resent = (task_ctx.fastresend > 0) ? task_ctx.fastresend : 0xffffffff
            var rtomin = (task_ctx.nodelay == 0) ? (task_ctx.rx_rto >>> 3) : 0
            // 打包发送
            for (var seq in task_ctx.snd_buf) {
                var needsend = 0
                var current = getCurTimeStamp()
                var segment = task_ctx.snd_buf[seq]
                var { mtype, flag, cf, tn, seq, connid, buf } = segment
                if (segment.xmit == 0) {  // 首次发送
                    needsend = 1
                    segment.xmit++
                    segment.resendts = current + task_ctx.rx_rto + rtomin
                } else if (current > segment.resendts) {  // 出现超时重传
                    needsend = 1
                    segment.xmit++
                    if (task_ctx.nodelay == 0) {
                        segment.rto += Math.max(segment.rto, task_ctx.rx_rto)
                    } else {
                        var step = (task_ctx.nodelay < 2) ? (segment.rto) : task_ctx.rx_rto
                        segment.rto += step / 2
                    }
                    segment.resendts = current + segment.rto;
                } else if (segment.fastack >= resent) {  // 快速重传
                    if (segment.xmit <= task_ctx.fastlimit || task_ctx.fastlimit <= 0) {
                        needsend = 1
                        segment.xmit++
                        segment.fastack = 0
                        segment.resendts = current + segment.rto
                    }
                }
                if (needsend) {
                    // TODO? 是否需要合并到mtu发送
                    var ctx = { payload: buf }
                    var kupack = new Package(mtype, flag, cf, tn, seq, connid, ctx)
                    this.kudp_output(address, port, kupack.buffer)
                    if (segment.xmit >= task_ctx.dead_link) {
                        task_ctx.snd_state = SND_STATE_TIMEOUT
                    }
                }
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
         * 恢复task原始状态，主要是受到RESET包
         * @param {*} task_ctx 
         * @param {*} force 
         */
        _snd_task_restore(task_ctx, force) {
            task_ctx.snd_state = SND_STATE_RESET
            task_ctx.snd_que = {}  // 清理待发送的数据包
            task_ctx.nsnd_que = 0  // 清0
            task_ctx.snd_buf = {}  // 清理发送窗口的数据包, TODO:此时接收到ACK的处理
            task_ctx.nsnd_buf = 0  // 清0
            task_ctx.snd_timer && task_ctx.snd_timer.stop() // 停止发送定时器
            task_ctx.wnd_timer && task_ctx.wnd_timer.stop() // 停止0窗口询问定时器
            if (force) {
                // TODO: 通知业务层清理已收到的数据包
            }
        }

        /**
         * 在一个虚拟连接创建一个task
         * @param {*} fd connect 返回的连接号
         * @param {*} swnd 设置的发送窗口大小
         * @param {*} rwnd 设置的接收窗口大小
         * @returns 
         */
        create(fd, swnd, rwnd) {
            var { cf, connid, cid, address, port } = this.conn.fstat(fd)
            // 创建任务 TODO 前置发起方为奇数 后置发起方是偶数
            var { tn, seq } = this.seqer.malloc()
            var snd_wnd = swnd || SND_WND
            var rcv_wnd = rwnd || RCV_WND
            var snd_que_siz = snd_wnd * SND_BUF_FACTOR
            var snd_buf_wnd = snd_wnd + snd_que_siz

            // 获取oid,标记唯一的标记连接的id
            var fdtn = this._initoid(cid, tn, address, port)
            this.conn.newTask(fdtn, SND_NAME, {
                fdtn, fd, tn, cf, connid, cid, isn: seq, address, port,
                rx_rtts: 0,                // 加权平均往返时间
                rx_rttd: 0,                // rtt偏差的加权平均
                rx_rto: SND_RTO_DEF,       // 初始化rto
                rx_minrto: SND_RTO_MIN,    // 最小rto
                fastlimit: SND_FASTACK_LIMIT,
                fastresend: 2,             // 重传次数超过该数值，快速重传
                nodelay: 0,                // 释放需要拥塞控制
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
                snd_timer: null,           // 发送数据定时器，超时重传定时器依赖与每个数据包的resentts
                wnd_timer: null,           // 0窗口询问定时器
            })
            return { fdtn, tn, isn: seq }
        }

        /**
         * 检测虚拟连接中task的堆积的数据包个数
         * @param {*} fdtn 由`create`创建出来的`fd task number`
         * @returns
         */
        kudp_waitsend(fdtn) {
            var task_ctx = this._snd_task_ctx(fdtn)
            if (!utils.isNull(task_ctx)) {
                return task_ctx.nsnd_buf + task_ctx.nsnd_que
            }
            return -1
        }

        /**
         * 检测虚拟连接中task是否可以继续接受发送数据
         * @param {*} fdtn 由`create`创建出来的`fd task number`
         * @returns bool
         */
        kudp_cansend(fdtn) {
            var task_ctx = this._snd_task_ctx(fdtn)
            if (!utils.isNull(task_ctx)) {
                return (task_ctx.nsnd_buf + task_ctx.nsnd_que) < task_ctx.snd_buf_wnd
            }
            return false
        }

        /**
         * 将要发送的数据写入kudp内部
         * @param {*} fdtn 由`create`创建出来的`fd task number`
         * @param {*} buf 待发送的数据buf
         * @param {*} len 待发送的数据len
         * @param {*} flag
         * @returns
         *  0: 成功
         *  -1: 无效fdtn，获取不到_snd_task_ctx
         *  -2: 超过了kudp当前task的最大缓存
         *  -3:
         */
        kudp_send(fdtn, buf, len, flag) {
            var task_ctx = this._snd_task_ctx(fdtn)
            if (!utils.isNull(task_ctx)) {
                var nbuf = task_ctx.nsnd_buf + task_ctx.nsnd_que;
                // 没有超过最大发送端缓存的限制 snd_buf + snd_que 总和
                if (nbuf < task_ctx.snd_buf_wnd) {
                    var { seq, pack_ctx } = this._snd_data_pack(task_ctx, buf, len, flag)
                    return this._add_snd_que(task_ctx, seq, pack_ctx)
                } else {
                    return -2
                }
            }
            this.error(fd, fdtn, EINVALIDTASK, "invalid task")
            return -1
        }

        /**
         * 重置连接或task
         * @param {*} fdtn connect 返回的连接号
         * @param {*} fdtn 由`create`创建出来的`fd task number`
         * @param {*} flag 
         */
        kudp_reset(fd, fdtn, flag) {

        }

        /**
         * 发送广播消息
         * @param {*} options 记录广播内容中的kind编码表及信息
         */
        kudp_broadcast(options) {
            var { address, port } = options
            options.kind = options.kind || []
            options.kind.push({ kind: 0, value: this._id })
            var pcf = (options.kind && Object.keys(options.kind).length === 0) ? 0 : 1
            var kudpack = new Package(BROAD, pcf, 0, null, null, null, options)
            this.kudp_output(address, port, kudpack.buffer)
        }

        /************************************************** 面向接收器的api, 控制流及ACK **************************************************/
        /**
         * 收到需要回复响应的数据包
         * @param {*} fdtn 由`create`创建出来的`fd task number`
         * @param {*} ts 时间戳
         * @param {*} rmt_wnd 对端窗口大小
         * @param {*} ackpack 
         */
        __rcv_notify_snd(fdtn, ts, rmt_wnd, ackpack) {
            var task_ctx = this._snd_task_ctx(fdtn)
            if (task_ctx && !utils.isNull(rmt_wnd)) {
                task_ctx.rmt_wnd = rmt_wnd
            }
            console.log("__rcv_notify_snd", fdtn, ts, ackpack)
        }

        /**
         * 计算rto
         * @param {*} fd 
         * @param {*} ts 
         * @param {*} delta 
         */
        __update_snd_rto(fdtn, ts, delta) {
            var task_ctx = this._snd_task_ctx(fdtn)
            var rtt = getCurTimeStamp() - ts - delta;
            var { rx_rtts, rx_rttd, rx_minrto } = task_ctx
            if (rx_rtts == 0) {
                rx_rtts = rtt;
                rx_rttd = rtt / 2;
            } else {
                rx_rtts = (1 - SND_ALPHA) * rx_rtts + SND_ALPHA * rtt
                rx_rttd = (1 - SND_BETA) * rx_rttd + SND_BETA * Math.abs(rx_rtts - rtt)
                if (rx_rtts < 1) rx_rtts = 1
            }
            task_ctx.rx_rtts = rx_rtts
            task_ctx.rx_rttd = rx_rttd
            task_ctx.rx_rto = rx_rtts + 4 * rx_rttd
            task_ctx.rx_rto = _ibound_(rx_minrto, task_ctx.rx_rto, SND_RTO_MAX);
        }

        /**
         * 更新发送端记录的对端窗口大小, 主要是接收到 WSANS 数据包
         * @param {*} fdtn 
         * @param {*} rmt_wnd 
         * @param {*} mtype 
         */
        __update_snd_rmt_wnd(fdtn, rmt_wnd, mtype) {
            var task_ctx = this._snd_task_ctx(fdtn)
            if (task_ctx) {
                task_ctx.rmt_wnd = rmt_wnd
                // 如果对端接收窗口为0，启动窗口询问定时器
                if (0 == rmt_wnd) {
                    task_ctx.wnd_timer = task_ctx.wnd_timer || new timer({
                        onend: (args) => {
                            console.info("timer onend TODO:", ...args)
                        },
                        onstop: (...args) => { console.info("timer onstop:", ...args) }
                    }, [fdtn])
                    task_ctx.wnd_timer.start(SND_0WND_ASK_FREQ)
                }
            }
        }

        /**
         * 接收到控制类的数据包处理 主要是 RESET CLOSE
         * @param {*} fdtn 
         * @param {*} pcf 
         * @param {*} mtype 
         */
        __rcv_notify_ctrl(fdtn, pcf, mtype) {
            var task_ctx = this._snd_task_ctx(fdtn)
            switch (mtype) {
                case RESET:  // 重置逻辑
                    this._snd_task_restore(task_ctx, pcf)
                    break
                case CLOSE:
                    this._snd_task_restore(task_ctx, pcf) // TODO: close的收尾工作
                    break
                default:
                    break
            }
        }
    }

    /************************************************************** Recver ***************************************************************/
    class Recver {
        constructor(options = {}) {
            this.kudp_recv = options.input
            this.error = options.error
            this.conn = options.conn
            this.rcv_task = this.conn["task"]
            this.nodes = options.nodes
            this.sender = options.sender
            this._id = options._id
        }

        /**
         * 初始化oid
         * @param {*} cid 
         * @param {*} tn 
         * @param {*} address 
         * @param {*} port 
         * @returns 
         */
        _initoid(cid, tn, address, port) {
            var oid = [address, port, tn].join(SEP)
            if (cid && cid != "0x") {
                oid = [cid, tn].join(SEP)
            }
            return oid
        }

        /**
         * 获取某个连接的task的接收窗口
         * @param {*} fdtn 
         * @returns 
         */
        _rcv_task_rwnd(fdtn) {
            var task_ctx = this._rcv_task_ctx(fdtn) || {}
            var { rcv_wnd, nrcv_que } = task_ctx
            if (nrcv_que < rcv_wnd) {
                return rcv_wnd - nrcv_que
            }
            return 0
        }

        /**
         * 获取某个连接的task的上下文信息
         * @param {*} fdtn 
         */
        _rcv_task_ctx(fdtn) {
            if (this.rcv_task[fdtn] && this.rcv_task[fdtn][RCV_NAME]) {
                return this.rcv_task[fdtn][RCV_NAME]
            }
            return null
        }

        /**
         * 更新rcv_task_ctx的信息
         * @param {*} fdtn 
         * @param {*} options 
         */
        _update_rcv_task_ctx(fdtn, options) {
            var task_ctx = this._rcv_task_ctx(fdtn) || {}
            for (var key in options) {
                task_ctx[key] = options[key]
            }
        }

        /**
         * 初始化一个接收缓冲区, 只有接收到数据时才需要初始化
         * @param {*} cid 
         * @param {*} address 
         * @param {*} port 
         * @param {*} tn 
         * @param {*} mtype 
         * @param {*} seq 
         * @param {*} rwnd 
         * @returns 
         */
        _rcv_task_init(cid, address, port, tn, mtype, seq, rwnd) {
            var fdtn = this._initoid(cid, tn, address, port)
            // 如果需要，初始化isn
            var isn = (BEGIN == mtype || BDODO == mtype) ? seq : null;
            if (this.rcv_task[fdtn] && this.rcv_task[fdtn][RCV_NAME]) {
                if (isn && !this.rcv_task[fdtn][RCV_NAME]["isn"]) {
                    this.rcv_task[fdtn][RCV_NAME]["isn"] = isn
                }
                return fdtn
            }

            // 基本的配置信息
            var rcv_wnd = rwnd || RCV_WND
            var rcv_que_siz = rcv_wnd * RCV_BUF_FACTOR
            var rcv_buf_wnd = rcv_wnd + rcv_que_siz
            var rcv_ctx = {
                cid, address, port, tn, isn,
                fd, cf, connid, fdtn,
                rcvcnt: 0,                 // 已经接收的数据包个数
                rcv_que: {},               // 接收缓冲区（跟用户层接触的数据包）
                nrcv_que: 0,               // 接收缓冲区数据包数量
                rcv_buf: {},               // 接收窗口（协议缓存的数据包）
                nrcv_buf: 0,               // 接收窗口数据包数量
                rcv_nxt: isn || 0,         // 待接收的包序号
                rcv_wnd: rcv_wnd,          // 接收窗口大小
                rcv_que_siz: rcv_que_siz,  // 接收缓冲 rcv_que 的大小
                rcv_buf_wnd: rcv_buf_wnd,  // 最大接收端缓存的限制 rcv_buf + rcv_que 总和
                rcv_state: RCV_STATE_INIT, // 接收状态值
            }
            // 对于主动发出的数据包，收到响应时，根据cid 或 address, port，定位到连接信息
            if (this.rcv_task[fdtn] && !this.rcv_task[fdtn][RCV_NAME]) {
                var conninfo = this.conn.fconn(cid, address, port)
                var { fd, cf, connid, fdtn } = conninfo
                rcv_ctx.fd = fd
                rcv_ctx.cf = cf
                rcv_ctx.connid = connid
            }
            this.conn.newTask(fdtn, RCV_NAME, rcv_ctx)
            return fdtn
        }

        /**
         * 将ack数据写入sender内部
         * @param {*} fdtn 
         * @param {*} ts 
         * @param {*} rmt_wnd 
         * @param {*} ackpack 
         */
        _rcv_task_ack_push(fdtn, ts, rmt_wnd, ackpack) {
            var task_ctx = this._rcv_task_ctx(fdtn) || {}
            var { cid, fd, fdtn, address, port } = task_ctx
            this.sender.__rcv_notify_snd(fdtn, ts, rmt_wnd, ackpack)
        }

        /**
         * 解析来自网络的数据包
         *     recver不主动发送任何数据包，将通过吧数据包写入snd_que，由sender调度发送数据包
         * @param {*} address
         * @param {*} port
         * @param {*} buffer
         */
        kudp_input(address, port, buffer) {
            var rcv_ts = getCurTimeStamp()
            var kudpack = Package.unpack(buffer)
            if (!kudpack) {
                return -1
            }
            var { version, mtype, pcf, cf, cid, connid, header, body } = kudpack
            if (version != VERSION ||                          // 不合法的版本号
                !header.validType(mtype) ||                    // 无效的数据包类型
                !header.validPcf(pcf)) {                       // 无效的pcf
                return -2
            }
            // 数据包体中必要的信息
            var { ts, tn, seq, ctx } = body
            var fdtn = this._rcv_task_init(cid, address, port, tn, mtype, seq)
            // 通知sender 计算更新rto
            if (fdtn && tn && ts) {
                this.sender.__update_snd_rto(fdtn, ts, ctx.delta || 0)
            }
            console.log(kudpack.toHex(), body, ctx)
            console.log(header.toHex())
            // 从数据包获取对端的接收窗口rwnd
            var rmt_wnd = ctx.rwnd
            // 处理不同数据包类型
            switch (mtype) {
                case BROAD: // 记录路由，随机发送本地路由表
                    break;
                case MULTI: // 暂不处理
                    break;
                case RESET: // 重置fd 下的task
                case CLOSE: // 关闭连接fd，task
                    this.sender.__rcv_notify_ctrl(fd, tn, pcf, mtype)
                    break;
                case WSANS: // 窗口的大小回复通知, 更新 rmt_wnd
                case CTACK: // 控制流的数据包ACK, 更新 rmt_wnd
                case DTACK: // 更新rtt rmt_wnd
                    this.sender.__update_snd_rmt_wnd(fdtn, rmt_wnd, mtype)
                    break;

                /* 接收到以下类型的数据包，需要生成对应数据包作为"响应" */
                case WSASK: // 计算wnd, 生成WSANS返回
                    // 计算本端接收窗口
                    var rwnd = this._rcv_task_rwnd(fdtn)
                    var ack_ctx = { rcv_ts, rwnd }
                    var ackpack = new Package(WSANS, 0, cf, tn, seq, connid, ack_ctx)
                    this._rcv_task_ack_push(fdtn, ts, rmt_wnd, ackpack)
                    break;
                case PINGS:
                    // 计算本端接收窗口
                    var rwnd = this._rcv_task_rwnd(fdtn)
                    var ack_ctx = { rcv_ts, rwnd }
                    var ackpack = new Package(CTACK, 0, cf, tn, seq, connid, ack_ctx)
                    this._rcv_task_ack_push(fdtn, ts, rmt_wnd, ackpack)
                    break;
                case BEGIN: // 计算ACK NACK NDASK, payload 写入rcv_buf，检测rcv_nxt 进而写入rcv_que
                case DOING: // 计算ACK NACK NDASK, payload 写入rcv_buf，检测rcv_nxt 进而写入rcv_que
                case DONED: // 计算ACK NACK NDASK, payload 写入rcv_buf，检测rcv_nxt 进而写入rcv_que，更新fdtn 的state 为 SND_STATE_DONE
                    // 计算本端接收窗口
                    var rwnd = this._rcv_task_rwnd(fdtn)
                    var ack_ctx = { rcv_ts, rwnd }
                    var ackpack = new Package(DTACK, 0, cf, tn, seq, connid, ack_ctx)
                    this._rcv_task_ack_push(fdtn, ts, rmt_wnd, ackpack)
                case BDODO: // 计算ACK
                    // 计算本端接收窗口
                    var rwnd = this._rcv_task_rwnd(fdtn)
                    var ack_ctx = { rcv_ts, rwnd }
                    var ackpack = new Package(DTACK, 0, cf, tn, seq, connid, ack_ctx)
                    this._rcv_task_ack_push(fdtn, ts, rmt_wnd, ackpack)
                    break;
                default:
                    break;
            }
        }

        /**
         * 应用层获取数据 TODO
         * @param {*} fdtn 
         * @param {*} buf 
         * @param {*} len 
         * @param {*} flag 
         */
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
            var connid = new ConnectId(2)
            this._id = connid.toNumber() + ''
            // 虚拟连接器
            this.conn = new Connector()
            // 节点信息
            this.nodes = {}
            // 发送器
            this.sender = new Sender({
                output: this.write.bind(this),
                error: this.error.bind(this),
                conn: this.conn,
                _id: this._id,
            })
            // 接收器
            this.recver = new Recver({
                output: this.write.bind(this),
                input: this.recv.bind(this),
                error: this.error.bind(this),
                conn: this.conn,
                nodes: this.nodes,
                sender: this.sender,
                _id: this._id,
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
            var options = {
                cf: flag,
                port: port,
                address: address,
            }
            return this.conn.connect(options);  // 创建一个虚拟连接器
        }

        /**
         * 关闭kudp连接
         * @param {*} fd 由`open`创建出来的文件描述符
         *
         * 返回: 空
         */
        close(fd) {
            return this.conn.disconnect(fd);     // 关闭一个虚拟连接器
        }

        /**
         * 在一个kudp连接创建一个发送通道task
         * @param {*} fd 由`open`创建出来的文件描述符
         * @param {*} snd_wnd 发送窗口
         * @param {*} rcv_wnd 接收窗口
         * @returns 
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
            console.log(fd, fdtn, code, msg)
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
            return this.sender.kudp_reset(fd, fdtn, flag)
        }

        /**
         * 局域网内，广播消息
         * @param {*} options 一些需要广播附带的信息，用于搭建组网的基本信息
         */
        broadcast(options = {}) {
            var { address, port } = this.conn.fstat(FD_BROAD)
            options.address = address
            options.port = port
            options.kind = [{ kind: 1, value: "hello BROAD" }]
            this.sender.kudp_broadcast(options)
        }
    }

    return kudp;
}))