var fs    = require('fs');
var path  = require('path');
var util  = require('./util');
var spawn = require('child_process').spawn;
var async = require('async');
var http  = require('http');
var url   = require('url');
var nginx = require('./nginx');
var pm2   = require('pm2');

var currentContext = null;

module.exports = {
	reload: reload,
	start: start,
	stop: stop
};

function reload(currentContext, cb){
	async.waterfall([
		function(cb){ cb(null, currentContext); },
		readFolders,
		loadMeta,
		writeNginxServerConfig,
		readCurrentVersion,
		writeNginxDefaultConfig,
		readNewVersions,
		allocatePorts,
		removeOldProcesses,
		spawnProcesses,
		writeNginxAppConfig,
		writeMetaFile,
		reloadNginx
		], function(err, ctx){
			if (cb){ cb(err, ctx); }
		});
}

function start(op, cb){
	async.waterfall([
		function(cb){ cb(null, op); },
		setupContext,
		readFolders,
		loadMeta,
		writeNginxServerConfig,
		readCurrentVersion,
		writeNginxDefaultConfig,
		readNewVersions,
		allocatePorts,
		removeOldProcesses,
		spawnProcesses,
		writeNginxAppConfig,
		writeMetaFile,
		writeNginxConfig,
		reloadNginx,
		adminListen
		], function(err, ctx){
			if (err){ return cb(err); }
			currentContext = ctx;
			cb(null, ctx);
		});
}

function stop(cb){
	currentContext.stopping = true;
	pm2.connect(function(err){
		async.each(currentContext.instances, function(proc, cb2){
			console.log('stopping ' + proc.name);
			pm2.stop(proc.name, cb2);
		}, function(err){
			pm2.disconnect(cb);
			currentContext.httpServer.close();
			if(cb){ cb(null, currentContext); }
		});
	});
}

function setupContext(op, cb){
	var ctx = {
		instances: null,
		folders: null,
		processes: {},
		op: op,
		metaInfo: null,
		metaFile: null,
		usedPorts: [],
		nginx: {
			locations: [],
			server: {}
		}
	};
	cb(null, ctx);
}

function readFolders(ctx, cb){
	console.log('reading folders');
	var op = ctx.op;
	ctx.folders = fs.readdirSync(op.path)
	cb(null, ctx);
}



function readCurrentVersion(ctx, cb){
	console.log('reading current version');
	var op = ctx.op;
	ctx.currentVersionFile = path.join(op.path, 'current');
	if (fs.existsSync(ctx.currentVersionFile)){
		ctx.currentVersion = fs.readFileSync(ctx.currentVersionFile, 'utf8').trim();
	}
	cb(null, ctx);
}

function writeNginxServerConfig(ctx, cb){
	console.log('writing nginx server config');
	var op = ctx.op, metaInfo = ctx.metaInfo;

	ctx.nginx.server = {
		ip: op.ip || '',
		port: op.port || 0,
		name: op.name || '',
		defaultInstance: metaInfo.defaultInstance
	};

	cb(null, ctx);
}

function writeNginxDefaultConfig(ctx, cb){
	console.log('writing nginx default config');
	var op = ctx.op, metaInfo = ctx.metaInfo;
	if (ctx.currentVersion){
		ctx.nginx.def = {
			ip: op.ip,
			port: op.port,
			name: op.name,
			currentVersion: ctx.currentVersion
		};
	}
	cb(null, ctx);
}

function loadMeta(ctx, cb){
	console.log('loading meta');
	var op = ctx.op;
	ctx.metaFile = path.join(op.path, 'meta.json');
	if (fs.existsSync(ctx.metaFile)){
		ctx.metaInfo = JSON.parse(fs.readFileSync(ctx.metaFile, 'utf8'));
	}
	else { ctx.metaInfo = {}; }

	if (!ctx.metaInfo.instances){ ctx.metaInfo.instances = {}; }
	ctx.instances = ctx.metaInfo.instances;
	cb(null, ctx);
}

function adminListen(ctx, cb){
	var op = ctx.op;

	var httpServer = http.createServer(function (req, res) {
		var urlInfo = url.parse(req.url, true);

		try{
			res.writeHead(200, {'Content-Type': 'application/json'});
			switch(urlInfo.pathname){
				case "/reload":
					if (urlInfo.query && urlInfo.query.version){
						fs.writeFileSync(ctx.currentVersionFile, urlInfo.query.version);
					}
					reload(currentContext, function(err, ctx){
						res.end(JSON.stringify(ctx.instances));
					});
					break;
				case "/resize":
				console.log(urlInfo.query);
					resize(urlInfo.query, function(err, ctx){
						res.end(JSON.stringify(ctx.instances));
					});
					break;
				case "/stop":
					process.exit(0);
						break;
				case "/processes":
					// Get all processes running
					pm2.connect(function(err){
						pm2.list(function(err, process_list) {
							pm2.disconnect(function(){
								console.log(process_list);
								res.end(JSON.stringify(process_list));
							})
						});
					});
					break;
				default:
					res.end(JSON.stringify(ctx.instances));
			}
		}
		catch(ex){
			res.writeHead(500, {'Content-Type': 'application/json'});
			res.end(JSON.stringify({ error: ex }));
		}
	});

	ctx.httpServer = httpServer;

	httpServer.listen(op.adminPort, '127.0.0.1', function(err){
		console.log('admin: listening on ' + op.adminPort);
		cb(err, ctx);
	});
}
function resize(opts, cb){
	var instances = ctx.instances;
	instance[opts.version].process.send(JSON.stringify({ command: 'resize', size: opts.size }));
	cb(null);
}
function readNewVersions(ctx, cb){
	console.log('reading new versions');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op;

	var i = 0;
	while(true){
		var folder = folders[i];
		var p = path.join(op.path, folder);
		var stats = fs.statSync(p);

		if (stats.isDirectory()){
			var instance = instances[folder];
			if (!instance){
				instances[folder] = instance = { port: 0 };
				instance.name = folder;
				instance.path = p;
			}
			else {
				ctx.usedPorts.push(instance.port);
			}
			i++;
		}
		else {
			folders.splice(i, 1);
		}
		if (i >= folders.length) break;
	}

	cb(null, ctx);
}

function removeOldProcesses(ctx, cb){
	console.log('removing old versions');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op, processes = ctx.processes;

	for(inst in instances){
		if (folders.indexOf(inst) === -1){
			var proc = processes[inst];
			if (proc){
				proc.obsoleteVersion = true;
				proc.process.kill('SIGINT');
			}
			fs.unlinkSync(instances[inst].nginxConf);
			delete instances[inst];
		}
	}

	cb(null, ctx);
}

function allocatePorts(ctx, cb){
	console.log('allocating ports');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op, templates = ctx.templates;
	var usedPorts = ctx.usedPorts, portRange = op.portRange;

	for(inst in instances){
		var instance = instances[inst];
		if (instance.port === 0){
			for (var i = portRange.min; i <= portRange.max; i++) {
				if (usedPorts.indexOf(i) === -1){
					instance.port = i;
					usedPorts.push(i);
					break;
				}
			};
		}
	}
	cb(null, ctx);
}

function writeNginxAppConfig(ctx, cb){
	console.log('writing nginx app configs');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op;
	var usedPorts = ctx.usedPorts;

	for(inst in instances){
		var instance = instances[inst];
		if (!instance.nginxConf){
			//instance.nginxConf = path.join(op.nginx, 'v-' + instance.name + '.conf');
			var location = {
				port: instance.port,
				name: instance.name
			};
			ctx.nginx.locations.push(location);
		}
	}
	cb(null, ctx);
}

function spawnProcesses(ctx, cb){
	console.log('spawning processes');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op, processes = ctx.processes;

	pm2.connect(function(err) {
		async.forEachOf(instances, function(item, key, cb2){
			spawnProcess(key, ctx, cb2);
		},
		function(err){
			pm2.disconnect(function(){
				cb(err, ctx);
			});
		});
	});
}

function spawnProcess(inst, ctx, cb){
	var instances = ctx.instances, processes = ctx.processes, op = ctx.op;
	var instance = instances[inst];

	var workerPath = path.join(instance.path, 'worker.js');
	console.log('starting ' + workerPath, inst);
  // Start a script on the current folder
  pm2.start(workerPath, { name: inst,
		  //exec_mode: 'cluster_mode',
			env: {
				// NODE_PORT: instance.port,
				// NODE_NAME: instance.name,
			  // WORKER_PATH: workerPath,
				// WORKER_COUNT: 5
			},
			instances: 5
			// noDeamon:
		}, function(err, proc) {
			console.log(err, proc);
    	if (err) throw err;

    // Get all processes running
    // pm2.list(function(err, process_list) {
    //   console.log(process_list);
		//
    //   // Disconnect to PM2
    //   //pm2.disconnect(function() { process.exit(0) });
    // });
		//console.log(proc);
		cb(null);
  });
}
function spawnProcess2(inst, ctx, respawn){
	var instances = ctx.instances, processes = ctx.processes, op = ctx.op;
	var instance = instances[inst];

	var workerPath = path.join(instance.path, 'worker.js');
	var processFile = path.join(__dirname, './cluster.js');

	var processInfo = processes[inst];
	if (!processInfo){ processes[inst] = processInfo = { respawnCount: 0 }; }

	console.log('Spawning process ' + processFile);
	(function(instance, processInfo){
		proc = spawn('node', [processFile], { env: {
			NODE_PORT: instance.port,
			NODE_NAME: instance.name,
		  WORKER_PATH: workerPath,
			WORKER_COUNT: 5
		}, cwd: instance.path });
		processInfo.running = true;

		var okTimeout = processInfo.okTimeout = setTimeout(function(){
			processInfo.respawnCount=0;
		}, 60000);
		okTimeout.unref();

		proc.stdout.on('data', function (data) {
			console.log(instance.name + ': stdout: ' + data);
		});

		proc.stderr.on('data', function (data) {
		  console.log(instance.name + ': stderr: ' + data);
		});

		proc.on('exit', function (data) {
			console.log(instance.name + ': exiting');

			processInfo.running = false;
			clearTimeout(okTimeout);
			if (!currentContext.stopping){
				if (processInfo.obsoleteVersion){
					delete processes[instance.name];
				}
				else {
					processInfo.respawnCount++;
					var respawnInterval = (processInfo.respawnCount >= op.respawn.limit ? op.respawn.limitInterval : op.respawn.interval) * 1000;

					processInfo.respawnTimeout = setTimeout(function(){
						spawnProcess(inst, ctx, true);
					}, respawnInterval);
					processInfo.respawnTimeout.unref();
				}
			}
		});

		proc.on('close', function (code) {
		  console.log(instance.name + ': child process exited with code ' + code);
		});
	})(instance, processInfo);

	processInfo.process = proc;

	// if respawn, rewrite the meta file to include the new pid
	if (respawn){
		writeMetaFile(ctx)
	}
}

function writeMetaFile(ctx, cb){
	console.log('writing meta file');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op;

	fs.writeFileSync(ctx.metaFile, JSON.stringify(metaInfo, null, " "));
	if (cb) { cb(null, ctx); }
}

function reloadNginx(ctx, cb){
	// console.log('reloading nginx');
	// var nginx = spawn('service', ['nginx', 'reload']);
	//
	// nginx.stdout.on('data', function (data) {
	//   console.log('nginx: stdout: ' + data);
	// });
	//
	// nginx.stderr.on('data', function (data) {
	//   console.log('nginx: stderr: ' + data);
	// });

	cb(null, ctx);
}
function writeNginxConfig(ctx, cb){
	nginx.writeConfig(ctx, function(err){
		if(err){ return cb(err); }
		cb(null, ctx);
	});
}
