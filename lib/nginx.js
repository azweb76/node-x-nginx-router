var fs    = require('fs');
var path  = require('path');
var util  = require('./util');
var async = require('async');

function loadTemplates(opt, cb){
  console.log('loadTemplates');
  async.map(['nginx_server', 'nginx_location', 'nginx_default'], function(item, cb){
    console.log(item);
    var p = path.resolve('./config/' + item + '.txt');
    fs.readFile(p, 'utf8', function(err, data){
      cb(err, { type: item, data: data });
    })
  }, function(err, items){
    if(err){ return cb(err); }

    var o = {};
    for (var i = 0; i < items.length; i++) {
      var t = items[i];
      o[t.type] = t.data;
    }
    cb(null, o);
  });
}

function writeConfig(opt, cb){
  loadTemplates(opt, function(err, templates){
    if(err){ return cb(err); }
    var nginxLocations = [];

    if(opt.nginx.def){
      opt.nginx.server.default = util.render(templates.nginx_default, opt.nginx.def);
    }
    else {
      opt.nginx.server.default = '';
    }

    for (var i = 0; i < opt.nginx.locations.length; i++) {
      var loc = opt.nginx.locations[i];

      var t = util.render(templates.nginx_location, loc);
      nginxLocations.push(t);
    }

    opt.nginx.server.locations = nginxLocations.join('\n');
    var nginxConfig = util.render(templates.nginx_server, opt.nginx.server);


    fs.writeFile(opt.op.nginxPath, nginxConfig, { encoding: 'utf8' }, function(err){
      cb(err);
    });
  })

}

module.exports = {
  writeConfig: writeConfig
};
