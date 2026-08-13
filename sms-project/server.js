const express = require('express');
const path = require('path');
const app = express();

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// Mount the SMS/Numbers API router
const apiRouter = require('./hs-2');
app.use('/api', apiRouter);

// Fallback to index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

module.exports = app;
