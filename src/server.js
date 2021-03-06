const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const { Database } = require('sqlite3');
const { scheduleJob } = require('node-schedule');
const uws = require('uws');
const moment = require('moment');
const { join } = require('path');
const { readdirSync, unlink, rename, copyFile } = require('fs');
const Logger = require('./resources/js/Logger');
const config = require('./config.json');

const bootDate = moment().format('YYYY-MM-DD');
const startOfBootWeek = moment().startOf('week').add(1, 'days'), endOfBootWeek = moment().endOf('week').add(1, 'days');
// add 1 day because moment sees sunday as start and saturday as end of week and i don't
const startOfBootMonth = moment().startOf('month'), endOfBootMonth = moment().endOf('month');

let counter = 0, daily = 0, weekly = 0, monthly = 0, average = 0, fetchedDaysAmount = 1;
const sounds = [], statistics = {};

// on-boot database interaction
const db = new Database(config.databasePath);

db.serialize(() => {
	db.run(`
		CREATE TABLE IF NOT EXISTS sounds ( 
			id INTEGER PRIMARY KEY, 
			filename TEXT NOT NULL UNIQUE, 
			displayname TEXT NOT NULL, 
			source TEXT NOT NULL, 
			count INTEGER NOT NULL
		)
	`);

	db.all('SELECT * FROM sounds', [], (error, rows) => {
		rows.map(sound => sounds.push(sound));
		return Logger.info('Sounds & rankings loaded.');
	});

	db.run(`
		CREATE TABLE IF NOT EXISTS yamero_counter (
			counter INT NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS statistics (
			id INTEGER PRIMARY KEY,
			date TEXT NOT NULL UNIQUE,
			count INTEGER NOT NULL
		)
	`);
	db.run('INSERT OR IGNORE INTO statistics ( date, count ) VALUES ( date( \'now\', \'localtime\'), 0 )');

	db.get('SELECT counter FROM yamero_counter', [], (error, row) => {
		if (!row) db.run(`INSERT INTO yamero_counter ( counter ) VALUES ( 0 )`);

		counter = row ? row.counter : 0;
		return Logger.info('Main counter loaded.');
	});

	// make sure all necessary tables with at least one necessary column exist

	db.all('SELECT * FROM statistics', [], (error, rows) => {
		const thisWeek = rows.filter(row => moment(row.date).isBetween(startOfBootWeek, endOfBootWeek, null, []));
		const thisMonth = rows.filter(row => moment(row.date).isBetween(startOfBootMonth, endOfBootMonth, null, []));
		// null & [] parameters given for including first and last day of range (see moment docs)

		daily = rows.find(row => row.date === bootDate).count;
		weekly = thisWeek.reduce((total, date) => total += date.count, 0);
		monthly = thisMonth.reduce((total, date) => total += date.count, 0);
		fetchedDaysAmount = thisMonth.length;
		average = Math.round(monthly / thisMonth.length);

		rows.map(date => statistics[date.date] = date.count);
		return Logger.info('Statistics loaded.');
	});
});

// webserver
const server = express();
const http = require('http').Server(server);
const maintenanceMode = (process.argv.slice(2)[0] || '') === '--maintenance' ? true : false; // eslint-disable-line no-unneeded-ternary
const dateRegex = new RegExp(/^(\d{4})-(\d{2})-(\d{2})$/);

const pagePath = join(__dirname, '/pages');
const errorPath = join(pagePath, '/errorTemplates');
const pages = [];

readdirSync(pagePath).forEach(file => {
	const page = file.slice(0, -5).toLowerCase();
	if (file.substr(-5, 5) !== '.html' || config.errorTemplates.includes(page)) return;

	pages.push({
		name: file,
		path: join(pagePath, file),
		route: [`/${page}`, `/${page}.html`]
	});

	if (page === 'index') pages[pages.length - 1].route.push('/');
	// last array item because during current iteration it will be the last (adds root-dir route for index)
});

server.use(helmet());
server.set('trust proxy', 1);
server.use(express.urlencoded({ extended: false }));
server.use(session({
	secret: config.sessionSecret,
	resave: false,
	saveUninitialized: false,
	cookie: { secure: 'auto' }
}));
server.use(express.static('./resources'));

const upload = multer({
	dest: './resources/temp/',
	storage: multer.diskStorage({
		destination: './resources/sounds',
		filename(req, file, cb) {
			if (file.mimetype === 'audio/ogg') return cb(null, `${req.body.filename}.ogg`);
			else if (['audio/mpeg', 'audio/mp3'].includes(file.mimetype)) return cb(null, `${req.body.filename}.mp3`);
			else return cb(null, false);
		}
	}),
	fileFilter(req, file, cb) {
		if (!['audio/mpeg', 'audio/mp3', 'audio/ogg'].includes(file.mimetype)) return cb('Only mp3 and ogg files are accepted.');
		cb(null, true);
	}
}).array('files[]', 2);

/*
	Using a date iterator instead of simply looping over the statistics because I also want to fill out
	the object values for dates that are not present in the database. Looping over the stats wouldn't
	let me grab the dates that aren't present there and using a seperate date iterator inside that loop
	would not work if the difference between current stats iteration and date iterator is bigger than one.
*/
function filterStats(statsObj, startDate, endDate, statsCondition) {
	const iterator = startDate.clone();
	const result = {};

	if (!statsCondition) statsCondition = () => true; // if no condition provided, default to true

	while (iterator.diff(endDate) <= 0) {
		const formattedDate = iterator.format('YYYY-MM-DD');

		if (!statsObj.hasOwnProperty(formattedDate)) result[formattedDate] = 0;
		// check for days missing in statistics and insert value for those
		if (statsObj.hasOwnProperty(formattedDate) && statsCondition(iterator, startDate, endDate)) {
			result[formattedDate] = statsObj[formattedDate];
		}

		iterator.add(1, 'days');
	}

	return result;
}

http.listen(config.port, () => {
	const options = `${config.SSLproxy ? ' (Proxied to SSL)' : ''}${maintenanceMode ? ' (in Maintenance mode!)' : ''}`;
	return Logger.info(`megumin.love booting on port ${config.port}...${options}`);
});

server.get('/conInfo', (req, res) => res.json({ port: config.port, ssl: config.SSLproxy }));

server.get('/sounds', (req, res) => res.json(sounds));

server.get('/counter', (req, res) => {
	if (req.query.statistics === '') {
		return res.json({
			alltime: counter,
			daily,
			weekly,
			monthly,
			average
		});
	}

	return res.send(counter.toString());
});

server.get('/stats', (req, res) => { // eslint-disable-line complexity
	let requestedStats, countFiltered, dateFiltered;
	const firstStatDate = moment(Object.keys(statistics)[0]);
	const latestStatDate = moment(Object.keys(statistics)[Object.keys(statistics).length - 1]);
	// grab latest statistics entry from the object itself instead of just today's date to make sure the entry exists

	if (['from', 'to', 'equals', 'over', 'under'].some(selector => Object.keys(req.query).includes(selector))) {
		if ((req.query.from && !dateRegex.test(req.query.from)) || (req.query.to && !dateRegex.test(req.query.to))) {
			return res.status(400).json({ code: 400, name: 'Wrong Format', message: 'Dates must be provided in YYYY-MM-DD format.' });
		}

		const to = req.query.to ? moment(req.query.to) : null;
		const from = req.query.from ? moment(req.query.from) : null;
		const equals = req.query.equals ? parseInt(req.query.equals) : null;
		const over = req.query.over ? parseInt(req.query.over) : null;
		const under = req.query.under ? parseInt(req.query.under) : null;

		if ((to && to.isAfter(latestStatDate)) || (from && from.isAfter(latestStatDate))) {
			return res.status(400).json({ code: 400, name: 'Invalid timespan', message: 'Dates may not be in the future.' });
		}

		if ((to && from) && from.isAfter(to)) {
			return res.status(400).json({ code: 400, name: 'Invalid timespan', message: 'The start date must be before the end date.' });
		}

		if ((equals && isNaN(equals)) || (over && isNaN(over)) || (under && isNaN(under))) {
			return res.status(400).json({ code: 400, name: 'Invalid range', message: 'The "over", "under" and "equals" selectors must be numbers.' });
		}

		if ((over && under) && over > under) {
			return res.status(400).json({ code: 400, name: 'Invalid range', message: 'The "under" selector must be bigger than the "over" selector.' });
		}

		// count filtering
		if (equals || over || under) {
			if (equals) {
				countFiltered = filterStats(statistics, firstStatDate, latestStatDate, (iterator, startDate, endDate) => {
					return statistics[iterator.format('YYYY-MM-DD')] === equals;
				});
			}
			else if (over && !under) {
				countFiltered = filterStats(statistics, firstStatDate, latestStatDate, (iterator, startDate, endDate) => {
					return statistics[iterator.format('YYYY-MM-DD')] > over;
				});
			}
			else if (!over && under) {
				countFiltered = filterStats(statistics, firstStatDate, latestStatDate, (iterator, startDate, endDate) => {
					return statistics[iterator.format('YYYY-MM-DD')] < under;
				});
			}
			else if (over && under) {
				countFiltered = filterStats(statistics, firstStatDate, latestStatDate, (iterator, startDate, endDate) => {
					return statistics[iterator.format('YYYY-MM-DD')] > over && statistics[iterator.format('YYYY-MM-DD')] < under;
				});
			}
		}

		// date filtering
		const formattedFrom = from ? from.format('YYYY-MM-DD') : null;
		const formattedTo = to ? to.format('YYYY-MM-DD') : null;

		if (formattedFrom && !formattedTo) {
			requestedStats[formattedFrom] = statistics[formattedFrom] || 0;
		}
		else if (!formattedFrom && formattedTo) {
			requestedStats = filterStats(countFiltered ? countFiltered : statistics, firstStatDate, to, (iterator, startDate, endDate) => {
				return moment(iterator).isSameOrBefore(endDate);
			});
		}
		else if (formattedFrom && formattedTo) {
			requestedStats = filterStats(countFiltered ? countFiltered : statistics, from, to, (iterator, startDate, endDate) => {
				return moment(iterator).isBetween(startDate, endDate, null, []);
			});
			// null & [] parameters given for including first and last day of range (see moment docs)
		}
		else requestedStats = countFiltered;

		if (countFiltered) {
			for (const entryKey in requestedStats) {
				if (requestedStats[entryKey] === 0) delete requestedStats[entryKey];
			} // filter padded entries if a count filter is used
		}
	}
	else {
		requestedStats = filterStats(statistics, firstStatDate, latestStatDate);
	}

	return res.json(requestedStats);
});

server.post('/api/login', (req, res) => {
	if (req.session.loggedIn) {
		return res.json({ code: 401, message: 'Already logged in.' });
	}

	if (config.adminPassword === req.body.password) {
		req.session.loggedIn = true;
		Logger.info('A user has logged into the admin panel.');
		return res.json({ code: 200, message: 'Successfully logged in!' });
	}
	else {
		return res.json({ code: 401, message: 'Invalid password provided.' });
	}
});

server.get('/api/logout', (req, res) => {
	if (req.session.loggedIn) {
		req.session.destroy();
		Logger.info('A user has logged out of the admin panel.');
		return res.json({ code: 200, message: 'Successfully logged out!' });
	}
	else {
		return res.json({ code: 401, message: 'Not logged in.' });
	}
});

server.post('/api/upload', (req, res) => {
	if (!req.session.loggedIn) return res.json({ code: 401, message: 'Not logged in.' });

	upload(req, res, err => {
		if (err) return res.json({ code: 400, message: err });

		const data = req.body;
		Logger.info(`Upload process for sound '${data.filename}' initiated.`);

		if (sounds.find(sound => sound.filename === data.filename)) {
			Logger.error(`Sound with filename '${data.filename}' already exists, upload aborted.`);
			return res.json({ code: 400, message: 'Sound filename already in use.' });
		}
		else {
			let step = 0;
			const latestID = sounds.length ? sounds.reduce((prev, cur) => prev.id > cur.y ? prev : cur).id : 0;

			db.run('INSERT OR IGNORE INTO sounds ( filename, displayname, source, count ) VALUES ( ?, ?, ?, 0 )',
				data.filename, data.displayname, data.source,
				err => {
					if (err) {
						Logger.error(`An error occurred creating the database entry, upload aborted.`, err);
						return res.json({ code: 500, message: 'An unexpected error occurred.' });
					}
					Logger.info(`(${++step}/2) Database entry successfully created.`);

					sounds.push({ id: latestID + 1, filename: data.filename, displayname: data.displayname, source: data.source, count: 0 });

					Logger.info(`(${++step}/2) Rankings/Sound cache successfully entry created.`);

					setTimeout(() => {
						emitUpdate('soundUpdate', ['sounds']);
					}, 1000 * 0.5); // allow time for server to keep up and send actual new data

					return res.json({ code: 200, message: 'Sound successfully uploaded.' });
				});
		}
	});
});

server.post('/api/rename', (req, res) => {
	if (!req.session.loggedIn) return res.json({ code: 401, message: 'Not logged in.' });

	const data = req.body;
	const sound = sounds.find(sound => sound.filename === data.oldSound);
	const newValues = [data.newFilename, data.newDisplayname, data.newSource, data.oldSound];

	if (!sound) return res.json({ code: 400, message: 'Sound not found.' });
	else {
		Logger.info(`Renaming process for sound '${data.oldSound}' to '${data.newFilename}' (${data.newDisplayname}, ${data.newSource}) initiated.`);
		let step = 0;

		db.run('UPDATE sounds SET filename = ?, displayname = ?, source = ? WHERE filename = ?', newValues, err => {
			if (err) {
				Logger.error(`An error occurred updating the database entry, renaming aborted.`, err);
				return res.json({ code: 400, message: 'An unexpected error occurred.' });
			}
			Logger.info(`(${++step}/8) Database entry successfully updated.`);

			sound.filename = data.newFilename;
			sound.displayname = data.newDisplayname;
			sound.source = data.newSource;

			Logger.info(`(${++step}/8) Rankings/Sound cache entry successfully updated.`);

			['ogg', 'mp3'].map(ext => { // eslint-disable-line arrow-body-style
				return copyFile(`./resources/sounds/${data.oldSound}.${ext}`, `./resources/sounds/${data.oldSound}.${ext}.bak`, err => {
					if (err) {
						Logger.error(`An error occurred backing up the original ${ext} file, renaming aborted.`, err);
						return res.json({ code: 400, message: 'An unexpected error occurred.' });
					}
					Logger.info(`(${++step}/8) Original ${ext} soundfile successfully backed up.`);

					rename(`./resources/sounds/${data.oldSound}.${ext}`, `./resources/sounds/${data.newFilename}.${ext}`, err => {
						if (err) {
							Logger.error(`An error occurred renaming the original ${ext} soundfile, renaming aborted, restoring backup.`, err);
							rename(`./resources/sounds/${data.oldSound}.${ext}.bak`, `./resources/sounds/${data.oldSound}.${ext}`, err => {
								if (err) return Logger.error(`Backup restoration for the ${ext} soundfile failed.`);
							});

							return res.json({ code: 400, message: 'An unexpected error occurred.' });
						}
						Logger.info(`(${++step}/8) Original ${ext} soundfile successfully renamed.`);

						unlink(`./resources/sounds/${data.oldSound}.${ext}.bak`, err => {
							if (err) {
								Logger.error(`An error occurred deleting the original ${ext} soundfile backup, please check manually.`, err);
							}
							Logger.info(`(${++step}/8) Original ${ext} soundfile backup successfully deleted.`);
						});
					});
				});
			});
			setTimeout(() => {
				emitUpdate('soundUpdate', ['sounds']);
			}, 1000 * 0.5); // allow time for server to keep up and send actual new data

			return res.json({ code: 200, message: 'Sound successfully renamed.' });
		});
	}
});

server.post('/api/delete', (req, res) => {
	if (!req.session.loggedIn) return res.json({ code: 401, message: 'Not logged in.' });

	const data = req.body;
	const sound = sounds.find(sound => sound.filename === data.sound);

	if (!sound) return res.json({ code: 400, message: 'Sound not found.' });
	else {
		Logger.info(`Deletion process for sound '${data.sound}' initiated.`);
		let step = 0;

		db.run('DELETE FROM sounds WHERE filename = ?', data.sound, err => {
			if (err) {
				Logger.error('An error occurred while deleting the database entry, deletion aborted.', err);
				return res.json({ code: 500, message: 'An unexpected error occurred.' });
			}
			Logger.info(`(${++step}/4) Database entry successfully deleted.`);

			['ogg', 'mp3'].map(ext => { // eslint-disable-line arrow-body-style
				return unlink(`./resources/sounds/${data.sound}.${ext}`, err => {
					if (err) {
						Logger.error(`An error occurred while deleting the ${ext} soundfile, deletion aborted.`, err);
						return res.json({ code: 500, message: 'An unexpected error occurred.' });
					}
					Logger.info(`(${++step}/4) ${ext} soundfile successfully deleted.`);
				});
			});

			sounds.splice(sounds.findIndex(sound => sound.filename === data.sound), 1);
			Logger.info(`(${++step}/4) Rankings/Sound cache entry successfully deleted.`);

			setTimeout(() => {
				emitUpdate('soundUpdate', ['sounds']);
			}, 1000 * 0.5); // allow time for server to keep up and send actual new data

			return res.json({ code: 200, message: 'Sound successfully deleted.' });
		});
	}
});

if (!maintenanceMode) {
	for (const page of pages) {
		if (page.name === 'admin.html') {
			server.get(page.route, (req, res) => {
				if (!req.session.loggedIn) return res.sendFile(page.path.replace('admin', 'login'));
				else return res.sendFile(page.path);
			});
			continue;
		}
		server.get(page.route, (req, res) => res.sendFile(page.path));
	}
}

for (const error of config.errorTemplates) {
	if (maintenanceMode) {
		return server.get(/.*/, (req, res) => res.status(503).sendFile('503.html', { root: './pages/errorTemplates/' }));
	}
	else {
		server.use((req, res) => res.status(error).sendFile(`${error}.html`, { root: './pages/errorTemplates/' }));
	}
}

// socket server
const socketServer = new uws.Server({ server: http });
const sockets = new Set();

function emitUpdate(event, types, socket) {
	const values = {
		counter: types.includes('counter') ? counter : null,
		statistics: types.includes('statistics') ? { alltime: counter, daily, weekly, monthly, average } : null,
		sounds: types.includes('sounds') ? sounds : null
	};

	if (socket) return socket.send(JSON.stringify({ type: event, values }));
	else return sockets.forEach(socket => socket.send(JSON.stringify({ type: event, values })));
}

socketServer.on('connection', socket => {
	sockets.add(socket);
	socket.pingInterval = setInterval(() => socket.ping(), 1000 * 45);

	socket.on('message', message => {
		let data;

		try {
			data = JSON.parse(message);
		}
		catch (e) {
			data = {};
		}

		if (!['click', 'sbClick'].includes(data.type)) return;

		if (data.type === 'click') {
			const currentDate = moment().format('YYYY-MM-DD');
			++counter; ++daily;
			++weekly; ++monthly;
			average = Math.round(monthly / fetchedDaysAmount);

			statistics[currentDate] = daily;

			return emitUpdate('counterUpdate', ['counter', 'statistics']);
		}

		if (data.type === 'sbClick') {
			if (!data.sound) return;

			let soundEntry = sounds.find(sound => sound.filename === data.sound.filename);
			if (!soundEntry && !sounds.find(s => data.sound.filename === s.filename)) return;
			// safeguard against requests with sounds that don't exist from being saved serverside
			// no need to check other props because if it's found, only count will be incremented (no user input)

			if (soundEntry) ++soundEntry.count;
			else soundEntry = Object.assign(data.sound, { count: 1 });

			return emitUpdate('counterUpdate', ['sounds']);
		}
	});

	socket.on('close', (code, reason) => {
		clearInterval(socket.pingInterval);
		sockets.delete(socket);
	});
});

// database updates
scheduleJob(`*/${Math.round(config.updateInterval)} * * * *`, () => {
	db.serialize(() => {
		db.run(`UPDATE yamero_counter SET \`counter\` = ${counter}`);

		db.run(`INSERT OR IGNORE INTO statistics ( date, count ) VALUES ( date('now', 'localtime'), ${daily} )`);
		db.run(`UPDATE statistics SET count = ${daily} WHERE date = date('now', 'localtime')`);

		for (const sound of sounds) {
			db.run(`UPDATE sounds SET count = ${sound.count} WHERE filename = '${sound.filename}'`);
		}
	});

	return Logger.info('Database updated.');
}); // update db at every n-th minute

scheduleJob('0 0 1 * *', () => {
	monthly = 0; fetchedDaysAmount = 1;

	Logger.info('Monthly counter & fetched days amount reset.');
	return emitUpdate('counterUpdate', ['statistics']);
}); // reset monthly counter at the start of each month

scheduleJob('0 0 * * 1', () => {
	weekly = 0;

	Logger.info('Weekly counter reset.');
	return emitUpdate('counterUpdate', ['statistics']);
}); // reset weekly counter at the start of each week (1 = monday)

scheduleJob('0 0 * * *', () => {
	daily = 0; ++fetchedDaysAmount;
	average = Math.round(monthly / fetchedDaysAmount);
	statistics[moment().format('YYYY-MM-DD')] = 0;

	Logger.info('Daily counter reset & fetched days amount incremented.');
	return emitUpdate('counterUpdate', ['statistics']);
}); // reset daily counter and update local statistics map at each midnight