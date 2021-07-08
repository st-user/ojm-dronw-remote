const { PORT, NODE_ENV } = require('./components/Environment.js');

const express = require('express');
const helmet = require('helmet');

const { v4: uuidv4 } = require('uuid');
const { verify } = require('./components/token.js');
const logger = require('./components/Logger.js');
const RemoteServer = require('./components/RemoteServer.js');
const LocalServer = require('./components/LocalServer.js');
const { storage } = require('./components/Storage.js');
const UsageChecker = require('./components/UsageChecker.js');

const app = express();

app.use(helmet());
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'connect-src': ['\'self\' wss:']
        },
    })
);
app.use(express.json());
app.use('/', express.static('dist'));
app.use('/audience', express.static('dist'));

const httpServer = app.listen(PORT, () => {
    logger.info(`Listening on ${PORT}`);
});

const localServer = new LocalServer(httpServer);
const remoteServer = new RemoteServer(app);
new UsageChecker(localServer);

logger.info(`Environment: ${NODE_ENV}`);

function generateStartKey() {
    return uuidv4();
}

async function checkAccessToken(req, res) {

    const bearerToken = req.headers['authorization'] || '';
    const [ bearerStr, inputToken ] = bearerToken.split(' ');

    const tokens = await storage.getAccessTokens();
    const isTokenValid = bearerStr === 'bearer' && await verify(inputToken || '', tokens);
    if (!isTokenValid) {
        logger.warn('Invalid token');
        res.status(401);
        res.setHeader('WWW-Authenticate', 'Bearer realm=""');
        res.send('');
        return false;
    }
    return true;
}

app.get('/validateAccessToken', async (req, res) => {

    const isTokenValid = await checkAccessToken(req, res);
    if (!isTokenValid) {
        return;
    }

    res.sendStatus(200);
});

app.get('/generateKey', async (req, res) => {

    const isTokenValid = await checkAccessToken(req, res);
    if (!isTokenValid) {
        return;
    }

    const startKey = generateStartKey();
 
    await localServer.setStartKey(startKey);
    await remoteServer.setStartKeyIfAbsent(startKey);

    res.json({ startKey });
});

app.post('/ticket', async (req, res) => {

    const { startKey } = req.body;

    const ticket = await localServer.generateTicket(startKey);
    if (!ticket) {
        const _startKey = !startKey ? '' : startKey;
        logger.warn(`Invalid startKey: ${_startKey.slice(0, 5)}...`);
        res.status(401);
        res.send('Invalid startKey');
        return;
    }

    res.json({ ticket });
});

localServer.on('message', (ws, dataJson) => {


    const messageType = dataJson.messageType;

    const peerConnectionId = dataJson.peerConnectionId;
    const startKey = ws.__startKey;

    remoteServer.send(
        startKey, peerConnectionId,
        messageType, dataJson
    );

});

remoteServer.on(['offer'], ({ startKey }, data) => {
    localServer.send(startKey, data);
});