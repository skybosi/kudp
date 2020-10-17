# udp可靠传输 --- kudp

## **目标**
基于udp协议实现可靠传输，为更上层应用层提供可靠的"传输层"！

## **几个说明**

1. 基于udp协议
2. 实现可靠的传输
3. 封装过程不保持长连接
4. 基于数据报而不是字节流
5. 不做拥塞控制，只要设法保证数据不错、不丢、不乱

## **协议说明**
 [详见](./doc/kudp.md)

## **参考的第三方数据结构相关的库**

此外，相关的数据结构的库是单独维护，并按照自身需要做了一定的调整，感谢第三方数据结构的提供者的智慧

1. [BitSet](https://github.com/mattkrick/fast-bitset)  用于文件描述符的管理
2. [event](https://github.com/dannnney/weapp-event)    用于事件管理
3. [heapify](https://github.com/luciopaiva/heapify)    用于接收器中已确认seq的管理
4. task：用于模拟测试网络传输的并发情况
5. [timer](https://github.com/husa/timer.js)           用于接收器中的已确认seq的超时管理
6. [tree](https://github.com/vadimg/js_bintrees)       用于管理接收器中的队列

