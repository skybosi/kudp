# udp可靠传输 --- kudp

## **目标**
基于udp协议实现可靠传输，为更上层应用层提供可靠的"传输层"！

## **几个说明**

1. 基于udp协议
2. 实现可靠的传输
3. 封装过程不保持长连接
4. 基于数据报而不是字节流
5. 不做拥塞控制，只要设法保证数据不错、不丢、不乱

## 几个开发环境的说明：

1. 完全基于js
2. 首次应用场景时微信小程序

## **难点**

### 1. 如果保证可靠？
1. 传输可靠
   - 每个数据包都需要确认才能算传输完成
   - 超时重传机制
2. 数据可靠
   - 检验和
   - 序号标识顺序
3. 网络异常处理可靠
   - 针对网络异常情况的传输上下文处理，是否需要支持备份所有传输进度？（暂定不处理，但是会像业务层抛出异常，方便业务层恢复准备）

### 2. 如果标志传输阶段？
1. 传输过程开始阶段（首个数据包），涉及到的问题
   - 首个包的标志位
   - 分配不冲突的isn
2. 传输过程中间阶段（中间数据包），涉及到的问题
   - 中间数据包标志位
   - 传输网络异常检测
   - 传输因网络异常处理方法
3. 传输过程结束阶段（结束数据包），涉及到的问题
   - 传输结束的标志位
   - 序号的释放

### 3. 如何分配序号？
 1. 序号只是编号，不是字节数
 2. 生成过程尽可能随机，与发送接收两端关联
 3. 一对多端传输isn独立管理，互不干扰
 4. 一对一的长时间通讯必须保证数据包互不干扰，在传输过程中
   - 针对小数据（< MAX_PACK_SIZE = 512Byte = 0.5K）
     - 在没有中大数据传输的情况，随机分配，结束后立即释放
     - 在存在中大型数据传输的情况，绕过某个区间，初步设定为1024*2 = 2048
   - 针对中大型数据
     - 在现有的可用序号空间随机生成isn
     - 同时占用随后的isn+2048的序号范围，此范围在该数据传输结束前，禁止其他范围传输动作介入
 5. 关于序号的恶意占用问题处理
   - 对于小数据传输及时释放序号
   - 每个序号占用时间不能过长，最大不得超过86400s（更多时候是一次应用层长传输的超时时间），意味着一次传输过程不得超过86400s（避免恶意占用序号段，无法再次分配合适的序号段），对于超大型的数据（1T以上）传输，目前暂不考虑
   - 如果传输超时（不等于最大占用时间），大于等于网络传输的TIMEOUT时间，及时抛出异常告知应用处理，并立即释放对应的所有序号区间，做好备份工作（备份失败的序号，只是记录续点。不被后期重试时使用，重试时会重新分配isn）

### 4. 同步、定位数据包是否加入到整个协议的内
由于kudp是一个基于udp的可靠传输层实现，专注于保证传输的可靠性，对于同步、定位此类功能，不宜作为协议的一部分处理，建议作为一个附属功能对外提供服务，不过本质上还是基于基础可靠传输

## **数据包结构**

```mk
数据包格式:

        7      6      5      4      3      2      1      0   
    +------+------+------+------+------+------+------+------+
    | ack  |retain|retain|  qos |  dup |        type        | 头部（1byte）
    +------+------+------+------+------+------+------+------+
    |                 Sequence Number(4byte)                | 序列号（4byte）
    +------+------+------+------+------+------+------+------+
    |                    Checksum(2byte)                    | 校验和（2byte）
    +------+------+------+------+------+------+------+------+
    |          section          |           version         | 区段/版本号（1byte）
    +------+------+------+------+------+------+------+------+
    |                      data(nbyte)                      | 数据（nbyte）
    +------+------+------+------+------+------+------+------+

头部: 
    type 位(bit 0~2):
        000: 发送广播数据包 BROAD           001: 发送多播数据包 MULTI
        010: 发送开始数据包 BEGIN           011: 发送中间数据包 DOING
        100: 发送结束数据包 DONED           101: 开始中间结束数据包 BDD  对于小型数据, 首个数据包既是中间数据包又是最后一个数据包
    dup 位(bit 3):
        表示一个数据包在传输时是否因为原因重试，如果是重试即置为1，否则为0（默认0）
    dup 值:
        依赖dup标志统计出的一个值，用来衡量传输的环境优劣程度。
    qos 位(bit 4):
        表示是否是服务质量，待定是否需要
    retain位(bit 5~6):
        留作后面版本更新使用
    ack 位(bit 7)
        表示type对应的数据包对应的确认包

序列号:
    一次小型数据传输过程，占用一个数字
    一次中大型数据传输，最大由区段与放大因子决定，即滑动窗口

校验和:
    计算方法: 将checksum字节情况，讲整个数据采用checksum算法计算得到一个16bit(2byte)的数字填充到checksum的位置

数据:
    固定长度，最长MAX_PAGE（512byte），小于该值即为结束了

type = BEGIN 或 BDD:
区段 section (bit 4 ~ 7):
    用于通知接收方本次数据传输的最大传输序号范围，用于定位序号区段的功能。
    几个注意点：
        - 该数值不代表数据包的真实长度
        - 只是代表完成这次传输使用的最大的可用序号的
        - 超过时将会折返循环使用起始序号
        - 默认段的长度为 BASE_SECTION = 256，表示超过 MAX_PAGE，最低会分配 256个序号。
        - 数值表示的是默认段的倍数，默认是4，如果 默认的序号BASE_SECTION预估不足，可以通过该字段4 ~ 7bit进行放大。所以 最大 2^4 * 256 = 4096，所以默认 4 * 256 = 1024 ，结合每个序号的MAX_PAGE（512byte） 得：
            - 默认 1024 * MAX_PAGE = 1024 * 0.5 KB =  512 KB = 0.5 MB
            - 最大 4096 * MAX_PAGE = 4096 * 0.5 KB = 2048 KB = 2.0 MB

版本号 version (bit 0 ~ 3):
    协议版本 占用 4bit，即 2^4 = 16 个版本。当前版本 0。

```

所有的数据包，只要在checksum正确的时候才提交给应用层。

## **发送数据包流程**

<img src="./doc/kudp发送数据.jpg" style="zoom:40%" />

## **数据包上报逻辑**

上报，是指接收端从网络中接收到数据，在保证数据不丢 不重 不乱的情况下，上报给对应的应用层的操作。

由于数据的可靠性不能得到保证，加上重试机制，会出现dup的情况，此时，如果部分情况的上报到应用层，将很有可能导致应用层接收的数据混乱重复。所以需要在kudp层对数据的上报机制做相应的逻辑控制，保证有序有效的提交给应用层。

以下基本的思路：

1. 针对小型数据包(type = 3)的数据包：
   - 采用收到后，在反馈对应`确认包`后，`直接上报`，后续如果因为`确认包丢失`时，因为业务方会重复传输同一个数据包，`依旧`如实反馈确认包，直到没有反馈重复，自然就不会再次传输，简之：`收到即报`，重复时应对型的反馈`确认包`

2. 针对非小型数据包(type = 0 1 2)的数据包: 
   - 采用渐进式上报。每接受到一个数据包
     1. 先将该数据包序号加入缓冲区合适的位置
     2. 触发一次检测流程，检测接收缓冲区中所有连续序号且小于最大上报序号的数据。
     3. 记录下最大上报序号，首次数据包时初始化位isn-1，表示一个都没有上报
   - 此外为了避免接收缓冲区的数据包过多积累，而又未收到后续包，定时的扫描接受缓冲区中所有连续的序号的数据包，上报到业务，进而释放接收缓冲区。

<img src="./doc/kudp接收数据.jpg" style="zoom:40%" />

```
小型数据包(type = 3):
    A   --------1-------->   B   ------>  应用层  (应用已经收到数据并处理)
    A   <------ACK:1---------|   假设丢失了
    A   ------1 dup------>   B
    A   <------ACK:1---------|   假设A就收到  传输结束


非小型数据包(type = 0 1 2)
    A   --------1-------->   B   ------>  [1]
    A   <------ACK:1---------|   假设A就收到
    A   --------3-------->   B   ------>  [1,3]  ---->  应用层接收1号
    A   <------ACK:3---------|   假设丢失了
    A   ------3 dup------>   B   ------>  [3]
    A   --------2-------->   B   ------>  [2,3]  ---->  应用层接收2,3号
    A   <------ACK:2---------|   假设A就收到
               ...

   A        1    2    3    4    5    6


   B        1    2    3    4    5    6
```