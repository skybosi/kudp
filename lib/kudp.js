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
 *   onRerr: 接收传输异常时回调
 *   onRdone: 接收数据完成回调
 *   onWrite: 向发送器发送数据后的回调业务层的接口，目前是否无用
 *   onWerr: 发送异常时回调
 *   onWdone: 发送数据完成时回调
 *   onStat: 统计器向业务层回调的统计数据接口
 *
 * 考虑到目前业务支持，目前仅提供以上接口，后期版本申请将会根据需要信息，每一次升级版本，将会更新 VERSION。
 */
import {
    BROADWAY, FD_BROAD, LAN_PACK_SIZE, WAN_PACK_SIZE,
} from './constant';

import {
    BROAD, MULTI, BEGIN, DOING, DONED, BDD,
    ABROAD, AMULTI, ABEGIN, ADOING, ADONED, ABDD,
} from './kupack'

(function (g, f) {
    const e = typeof exports == 'object' ? exports : typeof g == 'object' ? g : {};
    f(e);
    if (typeof define == 'function' && define.amd) {
        define('kudp', e);
    }
})(this, function (exports) {
    const Recver = require('./recver')
    const Sender = require('./sender')
    const Stat = require('./common/Stat.js')
    const UdpBase = require('./UdpBase')

    class kudp extends UdpBase {
        constructor(port, options) {
            super(port);
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
            this.rQueue.recv(res);
        }

        // 发送数据回调
        _onSend(mtype, ip, port, message, dup) {
            this.sendStat(mtype, dup);
            return this.send(ip, port, message);
        }

        // 发送完毕时回调
        _onWdone(ip, port, mtype, RqID, seq, payload) {
            this.onWdone(ip, port, mtype, RqID, seq, payload);
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
        _handleOnMessage(ip, port, mtype, RqID, seq, payload) {
            this.onRead(ip, port, mtype, RqID, seq, payload);
        }

        // 由于数据包会再未收到对应ACK包时会重传，针对ACK包无需设置超时重传
        _sendAck(ip, port, mtype, seq) {
            return this.sQueue.send(null, ip, port, mtype | ABROAD, seq);
        }

        // 新建一次新的传输过程，分配一个唯一的fd
        open(ip, port, flag) {
            return this.sQueue.open(ip, port, flag);
        }

        // 关闭一次传输, 释放对应的fd
        close(fd) {
            this.sQueue.close(fd);
        }

        // 关闭一次传输, 释放对应的fd
        fstat(fd) {
            return this.sQueue.fstat(fd);
        }

        // 基础网络方法
        // 通过id发送mtype消息的数据data
        write(fd, ip, port, payload, flag) {
            let ret = this.sQueue.send(fd, ip, port, flag || BEGIN, payload);
            this.onWrite(fd, payload, ip, port);
            return ret;
        }

        // 定义大数据包时分块时回调
        chunked(cb, ctx) {
            this.sQueue.chunked(cb, ctx);
        }

        // 向某一个设备id发送同步类型的数据，主要是同步本设备的数据更新
        sync(ip, port, payload, mtype) {
            return this.sQueue.send(FD_BROAD, ip, port, mtype || BROAD, payload);
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
    exports.LAN_PACK_SIZE = LAN_PACK_SIZE
    exports.WAN_PACK_SIZE = WAN_PACK_SIZE
});