var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Hello World 2\n');
}).listen(process.env.NODE_PORT, '127.0.0.1');
console.log('Server running at http://127.0.0.1:1337/');
