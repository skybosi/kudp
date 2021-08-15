const kudp = require('../../kudp')
const ReadStream = require('../../common/stream/stream').ReadStream

var kudp0 = new kudp(5329);
let s3 = kudp0.open("127.0.0.1", 5328, 3)
var fdtn = kudp0.create(s3, 0)

var infile = new ReadStream("../tmp/1.txt", {
    // highWaterMark: 1350 * 2,
    autoClose: false,
})

// infile.on('close', () => {
//     kudp0.off('release', () => {
//         console.log('close release')
//     })
//     console.log('close')
// })

// kudp0.on('release', (ctx) => {
//     // console.log('release', ctx)
//     infile.resume();
// })

infile.on("data", (buf) => {
    var bufsize = kudp0.sendbuf_size(fdtn)
    // console.log(bufsize)
    if (buf.length > bufsize) {
        console.log('pause')
        infile.pause(); // 不能继续发送，等写入完成后再继续读取       
    }
    var flag = kudp0.send(fdtn, buf, buf.length)
    if (flag != 0) {
        console.log('pause2')
        infile.pause(); // 不能继续发送，等写入完成后再继续读取
    }
    console.log("send", buf)
})
