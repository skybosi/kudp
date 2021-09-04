const ReadStream = require('../stream').ReadStream
const WriteStream = require('../stream').WriteStream


var infile = new ReadStream("./test.jpg")
var outfile = new WriteStream("./test_new.jpg", {
    flags: 'w+',
    mode: 0o666,
    encoding: 'utf8',
    autoClose: true,
    start: 0,
})
infile.on("data", (buf) => {
    let flag = outfile.write(buf);
    if (!flag) {
        infile.pause(); // 不能继续读取了，等写入完成后再继续读取
    }
})
outfile.on('drain', () => {
    infile.resume();
})
