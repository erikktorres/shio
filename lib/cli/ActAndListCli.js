var qS = require('querystring');
var util = require('util');

var Command = require('commander').Command;
var restify = require('restify');

var fn = require("../fn.js");
var Lifecycle = require('../Lifecycle.js');
var Formatter = require('./Formatter.js');
var CoordinatorClient = require('./CoordinatorClient.js');

var splitter = function(str) {
	return str.split(',');
}

function ActAndListCli(config) {
	this.config = config;
	this.program = new Command();
	this.client = null;
	this.lifecycle = new Lifecycle();
}

ActAndListCli.prototype.doAction = function(payload, cb) {
  var queryObject = {};

  var fields = this.config.fields;
  for (var i = 0; i < fields.length; ++i) {
  	var field = fields[i].name
    if (this.program[field] != null) {
 	    queryObject[field] = this.program[field];
 	  }
  }

  if (this.client == null) {
		var host = this.program.host || process.env.SHIO_COORDINATOR_HOST || '0.0.0.0';
		var port = this.program.port || process.env.SHIO_COORDINATOR_PORT || 17000;

		var jsonClient = restify.createJsonClient(
			{ url: util.format('http://%s:%s', host, port), retry: { retries: 0 } }
		);
		this.lifecycle.register(jsonClient);

		this.client = jsonClient;
  }

  var path = util.format('%s?%s', this.config.endpoint, qS.stringify(queryObject));
  this.client.post(path, payload, function(err, req, res, result) {
  	cb(err, result);
  });
};

ActAndListCli.prototype.showFn = function() {
	var self = this;

	var fields = this.program.fields;
	if (fields == null) {
  	fields = this.config.defaultFields;
	}

	if (fields != null && fields.length === 1 && fields[0] === '_all') {
		fields = null;
	}

	if (fields == null) {
 		fields = this.config.fields.map(fn.accessor('name'));
 	}


	return this.doAction({type: 'show'}, function(err, results) {
		self.lifecycle.close();

		if (err != null) {
			console.warn("Error showing results:", err.message);
			return console.log(err.stack);
		}

		if (results.length == 0) {
			return console.log("No results match your query");
		}

		var formatter = Formatter.analyzeObjects(results, fields);

		if (! self.program.noHeader) {
			formatter.logHeader();
		}
		results.forEach(formatter.log.bind(formatter));
	});
};

ActAndListCli.prototype.doActionAndShow = function(payload) {
	var self = this;
	return this.doAction(
		payload,
		function(err, results) {
			if (err != null) {
				console.warn("Error doing action[%j]!", payload, err.message);
				if (self.program.verbose) {
					console.log(err.stack);
				}
				return self.lifecycle.close();
			}
			self.showFn();
		}
	);
}

ActAndListCli.prototype.build = function(commandFn) {
	this.program
		.version("0.0.1")
		.option('-H, --host', 'specify the coordinator host.  Overrides SHIO_COORDINATOR_HOST env variable, defaults to 0.0.0.0')
		.option('-P, --port', 'specify the coordinator port.  Overrides SHIO_COORDINATOR_PORT, defaults to 8080')
		.option('-v, --verbose', 'verbose output')
	  .option('--noHeader', 'Show header line', false)
	  .option('--fields [fields]', 'Select fields to show', splitter);

  var fields = this.config.fields;
  for (var i = 0; i < fields.length; ++i) {
  	var field = fields[i];

  	var flags = '';
  	if (field.flag != null) {
  		flags += field.flag + ', ';
  	}
  	flags += util.format('--%s <%s>', field.name, field.name);

  	this.program.option(flags, util.format('only include a specific %s', field.name));
  }

	this.program
		.command("show")
		.description("shows all running processes")
		.action(this.showFn.bind(this));

  commandFn(this, this.program);

  return this;
}

ActAndListCli.prototype.run = function(argv) {
	if (argv == null) {
		argv = process.argv;
	}

	this.program.parse(argv);

  if (! this.program.args.length) {
	  this.program.help();
	}
}

module.exports = ActAndListCli;