const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const path = require('path');
require('dotenv').config();
const AWS = require('aws-sdk');
const bodyParser = require('body-parser');

const app = express();
const adminRoutes = require('./routes/admin');
const memberRoutes = require('./routes/member');

// Configure AWS SDK with region and credentials
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// DynamoDB Document Client
const dynamoDb = new AWS.DynamoDB.DocumentClient();

// Add this middleware for parsing application/x-www-form-urlencoded (for form submissions)
app.use(bodyParser.urlencoded({ extended: true }));

// Add this middleware for parsing application/json
app.use(bodyParser.json());

let client, adminClient;

// Initialize OpenID Client
async function initializeClient() {
    try {
        const issuer = await Issuer.discover(process.env.COGNITO_ISSUER_URL);
        client = new issuer.Client({
            client_id: process.env.COGNITO_CLIENT_ID,
            client_secret: process.env.COGNITO_CLIENT_SECRET,
            redirect_uris: [process.env.COGNITO_REDIRECT_URI],
            response_types: ['code']
        });
    } catch (err) {
        console.error('Error initializing OpenID client:', err);
    }
}
initializeClient().catch(console.error);

// Initialize OpenID Client for Admin
async function initializeAdminClient() {
    try {
        const adminIssuer = await Issuer.discover(process.env.COGNITO_ADMIN_ISSUER_URL);
        adminClient = new adminIssuer.Client({
            client_id: process.env.COGNITO_ADMIN_CLIENT_ID,
            client_secret: process.env.COGNITO_ADMIN_CLIENT_SECRET,
            redirect_uris: [process.env.COGNITO_ADMIN_REDIRECT_URI],
            response_types: ['code']
        });
    } catch (err) {
        console.error('Error initializing OpenID admin client:', err);
    }
}
initializeAdminClient().catch(console.error);

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false
}));

// Middleware for user authentication
const checkAuth = (req, res, next) => {
    req.isAuthenticated = !!req.session.userInfo;
    next();
};

// Home route
app.get('/', checkAuth, (req, res) => {
    res.render('index', {
        isAuthenticated: req.isAuthenticated,
        userInfo: req.session.userInfo
    });
});

// Login route to direct to Amazon Cognito
app.get('/login', (req, res) => {
    const nonce = generators.nonce();
    const state = generators.state();

    req.session.nonce = nonce;
    req.session.state = state;

    const authUrl = client.authorizationUrl({
        scope: 'email openid phone',
        state: state,
        nonce: nonce,
    });

    res.redirect(authUrl);
});

// Admin login route to direct to Amazon Cognito
app.get('/admin/login', (req, res) => {
    const nonce = generators.nonce();
    const state = generators.state();

    req.session.nonce = nonce;
    req.session.state = state;

    const authUrl = adminClient.authorizationUrl({
        scope: 'email openid phone',
        state: state,
        nonce: nonce,
    });

    res.redirect(authUrl);
});

// Callback for member login
app.get(getPathFromURL(process.env.COGNITO_REDIRECT_URI), async (req, res) => {
    try {
        const params = client.callbackParams(req);
        const tokenSet = await client.callback(
            process.env.COGNITO_REDIRECT_URI,
            params,
            {
                nonce: req.session.nonce,
                state: req.session.state
            }
        );

        const userInfo = await client.userinfo(tokenSet.access_token);
        req.session.userInfo = userInfo;
        req.session.userInfo.role = "member";

        // Add member to DynamoDB
        const dynamoParams = {
            TableName: 'Members',
            Item: {
                email: userInfo.email,
                "Member ID": userInfo.sub,
                name: userInfo.username,
                phone: userInfo.phone_number,
                role: 'member',
                createdAt: new Date().toISOString()
            },
            ConditionExpression: 'attribute_not_exists(email)' // Only add if not exists
        };

        try {
            await dynamoDb.put(dynamoParams).promise();
        } catch (dbError) {
            console.error('Error adding member to database:', dbError);
            // Continue even if DB insert fails
        }

        res.redirect('/index'); // Redirecting to member index
    } catch (err) {
        console.error('Callback error:', err);
        res.redirect('/');
    }
});

// Callback for admin login
app.get(getPathFromURL(process.env.COGNITO_ADMIN_REDIRECT_URI), async (req, res) => {
    try {
        const params = adminClient.callbackParams(req);
        const tokenSet = await adminClient.callback(
            process.env.COGNITO_ADMIN_REDIRECT_URI,
            params,
            {
                nonce: req.session.nonce,
                state: req.session.state
            }
        );

        const userInfo = await adminClient.userinfo(tokenSet.access_token);
        req.session.userInfo = userInfo;
        req.session.userInfo.role = "admin";

        res.redirect('/admin/index'); // Redirecting to admin index
    } catch (err) {
        console.error('Callback error:', err);
        res.redirect('/');
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy();
    const logoutUrl = `${process.env.COGNITO_LOGOUT_URL}?client_id=${process.env.COGNITO_CLIENT_ID}&logout_uri=${process.env.LOGOUT_REDIRECT_URI}`;
    res.redirect('/');
});

// Admin logout route
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    const logoutUrl = `${process.env.COGNITO_ADMIN_LOGOUT_URL}?client_id=${process.env.COGNITO_ADMIN_CLIENT_ID}&logout_uri=${process.env.LOGOUT_REDIRECT_URI}`;
    res.redirect('/');
});

// Node view engine
app.set('view engine', 'ejs');

// Routes
app.use('/admin', adminRoutes);
app.use('/member', memberRoutes);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

/*
// Creating an SNS service object
const sns = new AWS.SNS();

const sendEmailNotification = async (topicArn, subject, message) => {
    try {
        const params = {
            TopicArn: topicArn,
            Subject: subject,
            Message: message,
        };

        const result = await sns.publish(params).promise();
        console.log(`Message sent to topic: ${result.MessageId}`);
    } catch (error) {
        console.error(`Failed to send message: ${error.message}`);
    }
};

//SNS Topic ARN
const topicArn = 'arn:aws:sns:eu-west-1:396608771737:TaskManager'; 
const subject = 'Task Assignment Notification';
const message = 'This is an alert to tell you, you have been assigned a task.';

sendEmailNotification(topicArn, subject, message);
*/

// Start server
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});

// Helper function to get the path from the URL
function getPathFromURL(urlString) {
    try {
        const url = new URL(urlString);
        return url.pathname;
    } catch (error) {
        console.error('Invalid URL:', error);
        return null;
    }
}
