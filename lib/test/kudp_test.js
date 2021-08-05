const kudp = require('../kudp')
const BPORT = 5328

var kudp0 = new kudp(BPORT);
let s3 = kudp0.open("127.0.0.1", BPORT, 3)
var fdtn = kudp0.create(s3, 0)
// kudp0.send(fdtn, "hello kudp", 10)
kudp0.broadcast()