var cluster = require('cluster');
console.log(process.env);
var worker_env = {
  path: process.env.WORKER_PATH,
  workerCount: process.env.WORKER_COUNT,
  port: process.env.NODE_PORT
};

var workers = {};
process.on('SIGINT',function(){
  console.log('exiting cluster', process.id);
  for(var worker in workers){
    stopWorker(workers[worker], true);
  }
});

function stopWorker(worker, force){
  worker.kill('SIGINT');
}

process.on('message', function(msg){
  console.log(msg);
});

function start(){
  cluster.settings.exec = worker_env.path;
  // cluster.on('fork', function(worker) {
  //   console.log('forked: ' + worker.id);
  // });
  // cluster.on('listening', function(worker, address) {
  //   console.log('listening: ' + worker.id);
  // });
  // cluster.on('exit', function(worker, code, signal) {
  //   console.log('exit: ' + worker.id);
  // });

  forkWorkers();
}
function forkWorkers(){
  for (var i = 0; i < worker_env.workerCount; i++) {
    console.log('Forking worker: ' + i);
    var worker = cluster.fork({
      NODE_PORT: worker_env.port
    });
    worker.on('connected', function(err){
      console.log('worker connected');
    });
    worker.once('disconnect', function() {
      console.log('worker disconnected');
    });

    worker.once('exit', function cluExit(code, signal) {
      console.log('worker exited');
    });

    worker.once('online', function cluOnline() {
      console.log('worker online');
    });
    workers[worker.id] = worker;
  }
}

start();
