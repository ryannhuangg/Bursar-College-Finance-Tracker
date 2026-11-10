const failedLoads = new Set();
let errorToastTimer = null;
let connectionBanner = null;

(function injectConnectionStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .conn-banner { display: none; position: fixed; top: 0; left: 0; right: 0; z-index: 10000; align-items: center; justify-content: center; gap: 12px; padding: 8px 12px; background: #7f1d1d; color: #ffffff; font-size: 13px; font-weight: 600; }
        .conn-banner.visible { display: flex; }
        .conn-banner button { width: auto; margin: 0; padding: 4px 10px; background: rgba(255, 255, 255, 0.15); color: #ffffff; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
        .conn-toast { display: none; position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 10000; align-items: center; gap: 12px; padding: 12px 16px; background: #2a1215; color: #f87171; border: 1px solid #4c1d1d; border-radius: 8px; font-size: 14px; }
        .conn-toast.visible { display: flex; }
        .conn-toast button { width: auto; margin: 0; padding: 0; background: none; border: none; color: inherit; cursor: pointer; }
    `;
    document.head.appendChild(style);
})();

function syncConnectionBanner() {
    if (!document.body) return;
    if (!connectionBanner) {
        connectionBanner = document.createElement('div');
        connectionBanner.className = 'conn-banner';
        connectionBanner.innerHTML = '<span></span><button type="button">Retry</button>';
        connectionBanner.querySelector('button').addEventListener('click', () => location.reload());
        document.body.appendChild(connectionBanner);
    }
    const offline = !navigator.onLine;
    connectionBanner.classList.toggle('visible', offline || failedLoads.size > 0);
    connectionBanner.querySelector('span').innerText = offline
        ? "You're offline. Changes won't save until you reconnect."
        : "Some of your data didn't load.";
    connectionBanner.querySelector('button').style.display = offline ? 'none' : '';
}

window.addEventListener('offline', syncConnectionBanner);
window.addEventListener('online', () => {
    if (failedLoads.size) location.reload();
    else syncConnectionBanner();
});
document.addEventListener('DOMContentLoaded', syncConnectionBanner);

function friendlyErrorMessage(rawMessage, action) {
    const msg = (rawMessage || '').toLowerCase();
    const networkHints = ['fetch', 'network', 'timeout', 'offline', 'enotfound', 'econnrefused', 'econnreset', 'etimedout'];
    if (!navigator.onLine || msg === '' || networkHints.some((hint) => msg.includes(hint))) {
        return action === 'save'
            ? "Couldn't save — check your internet connection and try again."
            : "Couldn't load your data — check your internet connection.";
    }
    if (['signed in', 'session', 'jwt'].some((hint) => msg.includes(hint))) {
        return 'Your session expired. Sign out and log back in.';
    }
    return action === 'save'
        ? `Couldn't save: ${rawMessage}`
        : `Couldn't load your data: ${rawMessage}`;
}

function showErrorToast(message) {
    let toast = document.getElementById('errorToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'errorToast';
        toast.className = 'conn-toast';
        toast.innerHTML = '<span></span><button type="button">✕</button>';
        toast.querySelector('button').addEventListener('click', hideErrorToast);
        document.body.appendChild(toast);
    }
    toast.querySelector('span').innerText = message;
    toast.classList.add('visible');
    clearTimeout(errorToastTimer);
    errorToastTimer = setTimeout(hideErrorToast, 6000);
}

function hideErrorToast() {
    const toast = document.getElementById('errorToast');
    if (toast) toast.classList.remove('visible');
    clearTimeout(errorToastTimer);
}

async function loadKey(key) {
    try {
        const response = await window.electronAPI.getUserData(key);
        if (!response.success) {
            failedLoads.add(key);
            syncConnectionBanner();
            showErrorToast(friendlyErrorMessage(response.error, 'load'));
            return null;
        }
        failedLoads.delete(key);
        syncConnectionBanner();
        return response.value;
    } catch (err) {
        failedLoads.add(key);
        syncConnectionBanner();
        showErrorToast(friendlyErrorMessage(err.message, 'load'));
        return null;
    }
}

async function saveKey(key, value) {
    if (failedLoads.has(key)) {
        showErrorToast("Couldn't save because your data didn't load. Hit Retry and try again.");
        return false;
    }
    try {
        const response = await window.electronAPI.setUserData(key, value);
        if (!response.success) {
            showErrorToast(friendlyErrorMessage(response.error, 'save'));
            return false;
        }
        return true;
    } catch (err) {
        showErrorToast(friendlyErrorMessage(err.message, 'save'));
        return false;
    }
}
