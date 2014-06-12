var fs    = require('fs');
var path  = require('path');
var util  = require('./util');
var spawn = require('child_process').spawn;
var async = require('async');
var http  = require('http');
var url   = require('url');

var currentContext = null;

module.exports = {
	reload: reload,
	start: start
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
		loadTemplates,
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
		reloadNginx,
		adminListen
		], function(err, ctx){
			if (err){ return cb(err); }
			currentContext = ctx;
			cb(null, ctx);
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
		usedPorts: []
	};
	cb(null, ctx);
}

function readFolders(ctx, cb){
	console.log('reading folders');
	var op = ctx.op;
	ctx.folders = fs.readdirSync(op.path)
	cb(null, ctx);
}

function loadTemplates(ctx, cb){
	console.log('loading templates');
	ctx.templates = {
		serverTemplate: fs.readFileSync('./config/server_meta.txt', 'utf8'),
		locationTemplate: fs.readFileSync('./config/location_meta.txt', 'utf8'),
		defaultTemplate: fs.readFileSync('./config/default_meta.txt', 'utf8')
	};
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
	var templates = ctx.templates, op = ctx.op, metaInfo = ctx.metaInfo;

	if (!fs.existsSync(op.nginxAppPath)){
		fs.mkdirSync(op.nginxAppPath);
	}

	var serverFile = path.join(op.nginxPath, 'conf.d', op.name + '.conf');
	var serverMeta = util.render(templates.serverTemplate, {
		ip: op.ip,
		port: op.port,
		name: op.name,
		defaultInstance: metaInfo.defaultInstance
	});

	fs.writeFileSync(serverFile, serverMeta);
	cb(null, ctx);
}

function writeNginxDefaultConfig(ctx, cb){
	console.log('writing nginx default config');
	var templates = ctx.templates, op = ctx.op, metaInfo = ctx.metaInfo;
	if (ctx.currentVersion){
		var defaultMeta = util.render(templates.defaultTemplate, {
			ip: op.ip,
			port: op.port,
			name: op.name,
			currentVersion: ctx.currentVersion
		});
		var defaultFile = path.join(op.nginxPath, 'conf.d', op.name, 'default.conf');
		fs.writeFileSync(defaultFile, defaultMeta);
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
				case "/processes":
					var p = [];
					for(procName in ctx.processes){
						var proc = ctx.processes[procName];
						p.push({
							name: procName,
							connected: proc.connected,
							pid: proc.pid
						});
					}
					res.end(JSON.stringify(p));
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
				proc._obsoleteVersion = true;
				proc.kill('SIGINT');
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
			for (var i = portRange[0]; i <= portRange[1]; i++) {
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
		metaInfo = ctx.metaInfo, op = ctx.op, templates = ctx.templates;
	var usedPorts = ctx.usedPorts;

	for(inst in instances){
		var instance = instances[inst];
		if (!instance.nginxConf){
			instance.nginxConf = path.join(op.nginxAppPath, 'v-' + instance.name + '.conf');
			var locationMeta = util.render(templates.locationTemplate, {
				port: instance.port,
				name: instance.name
			});
			fs.writeFileSync(instance.nginxConf, locationMeta);
		}
	}
	cb(null, ctx);
}

function spawnProcesses(ctx, cb){
	console.log('spawning processes');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op, processes = ctx.processes;

	for(inst in instances){
		var proc = processes[inst];
		if (proc) continue;

		spawnProcess(inst, ctx)
	}
	cb(null, ctx);
}

function spawnProcess(inst, ctx, respawn){
	var instances = ctx.instances, processes = ctx.processes;
	var instance = instances[inst];

	var processFile = path.join(instance.path, 'worker.js');

	console.log('Spawning process ' + processFile);
	(function(instance){
		proc = spawn('node', [processFile], { env: { NODE_PORT: instance.port, NODE_NAME: instance.name }, cwd: instance.path });

		proc.stdout.on('data', function (data) {
		  console.log(instance.name + ': stdout: ' + data);
		});

		proc.stderr.on('data', function (data) {
		  console.log(instance.name + ': stderr: ' + data);
		});

		proc.on('exit', function (data) {
			console.log(instance.name + ': exiting');

			if (!currentContext.stopping){
				if (processes[instance.name]._obsoleteVersion){
					delete processes[instance.name];
				}
				else {
					setTimeout(function(){
						spawnProcess(inst, ctx, true);
					}, (op.respawn[1] * 1000));
				}
			}
		});

		proc.on('close', function (code) {
		  console.log(instance.name + ': child process exited with code ' + code);
		});

		instance.lastPid = proc.pid;
	})(instance);

	processes[inst] = proc;

	// if respawn, rewrite the meta file to include the new pid
	if (respawn){
		writeMetaFile(ctx)
	}
}

function writeMetaFile(ctx, cb){
	console.log('writing meta file');
	var instances = ctx.instances, folders = ctx.folders,
		metaInfo = ctx.metaInfo, op = ctx.op, processes = ctx.processes;

	fs.writeFileSync(ctx.metaFile, JSON.stringify(metaInfo, null, " "));
	if (cb) { cb(null, ctx); }
}

function reloadNginx(ctx, cb){
	console.log('reloading nginx');
	var nginx = spawn('service', ['nginx', 'reload']);

	nginx.stdout.on('data', function (data) {
	  console.log('nginx: stdout: ' + data);
	});

	nginx.stderr.on('data', function (data) {
	  console.log('nginx: stderr: ' + data);
	});

	cb(null, ctx);
}