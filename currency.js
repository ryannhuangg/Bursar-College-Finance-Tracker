const CURRENCY_SYMBOLS = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    CAD: '$'
};

function getCurrencyCode() {
    return localStorage.getItem('currencyCode') || 'USD';
}

function getCurrencySymbol() {
    return CURRENCY_SYMBOLS[getCurrencyCode()] || '$';
}

function applyCurrencySymbolToStaticFields() {
    const symbol = getCurrencySymbol();
    document.querySelectorAll('.dollar-sign').forEach((el) => {
        el.textContent = symbol;
    });
}

async function syncCurrencyFromAccount() {
    try {
        const result = await window.electronAPI.getUserData('currency');
        if (result && result.success && result.value) {
            localStorage.setItem('currencyCode', result.value);
        }
    } catch (err) {
    }
    applyCurrencySymbolToStaticFields();
}

document.addEventListener('DOMContentLoaded', () => {
    applyCurrencySymbolToStaticFields();
    syncCurrencyFromAccount();
});
