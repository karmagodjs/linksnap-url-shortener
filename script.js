let urlDatabase = [];
let stats = {
    totalUrls: 0,
    totalClicks: 0,
    todayUrls: 0
};

// Load data from memory on page load
window.onload = function () {
    loadData();

    document.getElementById('urlForm').addEventListener('submit', function (e) {
        e.preventDefault();
        shortenUrl();
    });
};

function generateShortCode(customAlias = '') {
    if (customAlias) {
        // Check if custom alias already exists
        const exists = urlDatabase.find(item => item.shortCode === customAlias);
        if (exists) {
            alert('This custom alias is already taken. Please choose another.');
            return null;
        }
        return customAlias;
    }

    let code;
    do {
        code = Math.random().toString(36).substring(2, 8);
    } while (urlDatabase.find(item => item.shortCode === code));

    return code;
}

function shortenUrl() {
    const originalUrl = document.getElementById('originalUrl').value;
    const customAlias = document.getElementById('customAlias').value.trim();

    if (!originalUrl) {
        alert('Please enter a valid URL');
        return;
    }

    try {
        new URL(originalUrl); // validate URL format
    } catch (err) {
        alert("Invalid URL format!");
        return;
    }

    const shortCode = generateShortCode(customAlias);
    if (!shortCode) return;

    const shortUrl = `${window.location.origin}/${shortCode}`;

    const urlData = {
        id: Date.now(),
        originalUrl: originalUrl,
        shortCode: shortCode,
        shortUrl: shortUrl,
        clicks: 0,
        createdAt: new Date().toLocaleDateString(),
        createdTime: new Date().toLocaleString()
    };

    urlDatabase.unshift(urlData);
    stats.totalUrls++;
    stats.todayUrls++;

    document.getElementById('shortUrl').textContent = shortUrl;
    document.getElementById('result').style.display = 'block';

    updateStats();
    displayUrlList();
    saveData();

    document.getElementById('originalUrl').value = '';
    document.getElementById('customAlias').value = '';
}

function copyToClipboard() {
    const shortUrl = document.getElementById('shortUrl').textContent;
    navigator.clipboard.writeText(shortUrl).then(function () {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.background = '#28a745';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '#28a745';
        }, 2000);
    });
}

function openUrl() {
    const shortUrl = document.getElementById('shortUrl').textContent;
    const urlData = urlDatabase.find(item => item.shortUrl === shortUrl);
    if (urlData) {
        urlData.clicks++;
        stats.totalClicks++;
        updateStats();
        saveData();
        window.open(urlData.originalUrl, '_blank');
    }
}

function updateStats() {
    document.getElementById('totalUrls').textContent = stats.totalUrls;
    document.getElementById('totalClicks').textContent = stats.totalClicks;
    document.getElementById('todayUrls').textContent = stats.todayUrls;
}

function displayUrlList() {
    const urlList = document.getElementById('urlList');
    const recentUrls = urlDatabase.slice(0, 5);

    let html = '<h3 style="margin-bottom: 15px; color: #333;">Recent URLs</h3>';

    recentUrls.forEach(url => {
        html += `
            <div class="url-item">
                <div>
                    <div style="font-weight: bold; color: #667eea; margin-bottom: 5px;">${url.shortUrl}</div>
                    <div class="original-url">${url.originalUrl}</div>
                    <div style="font-size: 12px; color: #999; margin-top: 5px;">Created: ${url.createdTime}</div>
                </div>
                <div class="clicks">${url.clicks} clicks</div>
            </div>
        `;
    });

    urlList.innerHTML = html;
}

function saveData() {
    // Save to localStorage (for demo)
    localStorage.setItem("urlDatabase", JSON.stringify(urlDatabase));
    localStorage.setItem("stats", JSON.stringify(stats));
}

function loadData() {
    const storedUrls = localStorage.getItem("urlDatabase");
    const storedStats = localStorage.getItem("stats");

    if (storedUrls && storedStats) {
        urlDatabase = JSON.parse(storedUrls);
        stats = JSON.parse(storedStats);
    } else {
        // Demo sample
        urlDatabase = [
            {
                id: 1,
                originalUrl: 'https://www.example.com/very-long-url-that-needs-shortening',
                shortCode: 'demo1',
                shortUrl: `${window.location.origin}/demo1`,
                clicks: 25,
                createdAt: new Date().toLocaleDateString(),
                createdTime: new Date().toLocaleString()
            }
        ];
        stats.totalUrls = urlDatabase.length;
        stats.totalClicks = urlDatabase.reduce((sum, url) => sum + url.clicks, 0);
        stats.todayUrls = urlDatabase.length;
    }

    updateStats();
    displayUrlList();
}
