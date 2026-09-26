const DEFAULT_CATEGORIES = [
    { name: 'Food', color: '#f59e0b' },
    { name: 'Fun', color: '#a855f7' },
    { name: 'Necessity', color: '#3b82f6' },
    { name: 'Other', color: '#6b7280' }
];
const NEW_TAG_PALETTE = ['#0ea5e9', '#eab308', '#ec4899', '#10b981', '#f97316', '#8b5cf6', '#14b8a6', '#ef4444'];
const SPECIAL_TAG_COLORS = {
    'Debt Payment': '#ef4444',
    'Goal Purchase': '#6366f1',
    'Subscription': '#14b8a6'
};

let financialStatsCache = null;
let undoAction = null;
let undoTimer = null;

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const netAmount = (p) => (Number(p.amount) || 0) - (Number(p.reimbursement) || 0);
const sumNet = (list) => list.reduce((sum, p) => sum + netAmount(p), 0);
const pendingReimbursement = (p) => (p.reimbursementSettled ? 0 : Number(p.reimbursement) || 0);
const isSurplusFunded = (p) => !!(p.isGoal || p.fromSurplus);
const isBoostDay = (d) => [0, 5, 6].includes(d.getDay());

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatCurrency(amount) {
    return getCurrencySymbol() + (Number(amount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatWhole(amount) {
    return getCurrencySymbol() + Math.round(Number(amount) || 0).toLocaleString();
}

function getLocalISO(d) {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60 * 1000);
    return local.toISOString().split('T')[0];
}

let audioCtx = null;

function getAudioCtx() {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

document.addEventListener('click', getAudioCtx, { once: true });

function playBrassNote(ctx, freq, startTime, length, peakGain) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2200;
    filter.Q.value = 0.7;

    const gainNode = ctx.createGain();
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);

    [-4, 4].forEach((detuneCents) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        osc.detune.value = detuneCents;
        osc.connect(filter);
        osc.start(startTime);
        osc.stop(startTime + length + 0.05);
    });

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.03);
    gainNode.gain.setValueAtTime(peakGain, startTime + length * 0.45);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + length);
}

function playChimeNote(ctx, freq, startTime, length, peakGain) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gainNode = ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + length + 0.05);

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.linearRampToValueAtTime(peakGain, startTime + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + length);
}

function playNotes(notes) {
    if (localStorage.getItem('soundsMuted') === 'true') return;
    try {
        const ctx = getAudioCtx();
        notes.forEach(([freq, start, length, gain]) => playBrassNote(ctx, freq, ctx.currentTime + start, length, gain));
    } catch {}
}

function playFanfareSound() {
    playNotes([[392.00, 0, 0.16, 0.16], [523.25, 0.18, 0.16, 0.16], [659.25, 0.36, 0.5, 0.20]]);
}

function playPurchaseLoggedSound() {
    if (localStorage.getItem('soundsMuted') === 'true') return;
    try {
        const ctx = getAudioCtx();
        playChimeNote(ctx, 440.00, ctx.currentTime, 0.11, 0.22);
        playChimeNote(ctx, 659.25, ctx.currentTime + 0.08, 0.16, 0.22);
    } catch {}
}

function todayISO() {
    return getLocalISO(new Date());
}

function daysBetween(start, end) {
    if (!start || !end) return 0;
    const diff = new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00');
    return diff >= 0 ? Math.round(diff / (1000 * 60 * 60 * 24)) + 1 : 0;
}

function calculateWeightRange(startDateObj, endDateObj, weightFactor) {
    let total = 0;
    for (const d = new Date(startDateObj); d <= endDateObj; d.setDate(d.getDate() + 1)) {
        total += isBoostDay(d) ? weightFactor : 1;
    }
    return total;
}

async function loadList(key) {
    const response = await window.electronAPI.getUserData(key);
    return response.success && Array.isArray(response.value) ? response.value : [];
}

function saveList(key, value) {
    return window.electronAPI.setUserData(key, value);
}

const loadPurchases = () => loadList('purchases');
const loadIncome = () => loadList('income');
const loadSubscriptions = () => loadList('subscriptions');
const saveSubscriptions = (subscriptions) => saveList('subscriptions', subscriptions);

async function savePurchases(purchases) {
    await saveList('purchases', purchases);
    financialStatsCache = null;
}

async function saveIncome(entries) {
    await saveList('income', entries);
    financialStatsCache = null;
}

async function getColorLookup(defaults, customKey, extra = {}) {
    const custom = await loadList(customKey);
    const colors = new Map([...defaults, ...custom].map((c) => [c.name, c.color]).concat(Object.entries(extra)));
    return (tag) => colors.get(tag) || '#6b7280';
}

const getPurchaseColors = () => getColorLookup(DEFAULT_CATEGORIES, 'custom_categories', SPECIAL_TAG_COLORS);

function legendHtml(tags, colorFor) {
    return tags.map((tag) => `
        <div class="legend-item">
            <div class="legend-color" style="background-color: ${colorFor(tag)}"></div>
            <span>${escapeHtml(tag)}</span>
        </div>
    `).join('');
}

function pieSvg(slices, total, stroke) {
    let angle = 0;
    const point = (a) => `${Math.cos(2 * Math.PI * a)} ${Math.sin(2 * Math.PI * a)}`;
    const shapes = slices.map((s) => {
        const share = s.amount / total;
        if (share <= 0) return '';
        const attrs = `fill="${s.color}" class="pie-slice" data-desc="${escapeHtml(s.desc)}" data-amount="${s.amount.toFixed(2)}" data-tag="${escapeHtml(s.tag)}"`;
        if (share >= 1) return `<circle r="1" cx="0" cy="0" ${attrs}></circle>`;
        const from = point(angle);
        angle += share;
        return `<path d="M 0 0 L ${from} A 1 1 0 ${share > 0.5 ? 1 : 0} 1 ${point(angle)} Z" stroke="${stroke}" stroke-width="0.015" ${attrs}></path>`;
    }).join('');
    return `<svg viewBox="-1 -1 2 2" class="daily-pie-chart"><circle r="1" cx="0" cy="0" fill="#26262b"></circle>${shapes}</svg>`;
}

function showUndoToast(message, action) {
    const toast = document.getElementById('undoToast');
    toast.querySelector('span').innerText = message;
    toast.querySelector('#undoBtn').style.display = action ? '' : 'none';
    toast.classList.add('visible');
    undoAction = action;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndoToast, 5000);
}

function hideUndoToast() {
    document.getElementById('undoToast').classList.remove('visible');
    undoAction = null;
    clearTimeout(undoTimer);
}

function createTagPicker(container, defaults, storageKey, onChange) {
    let selected = '';
    let adding = false;

    async function render(wanted) {
        const custom = await loadList(storageKey);
        const categories = [...defaults, ...custom].sort((a, b) => {
            if (a.name === 'Other') return 1;
            if (b.name === 'Other') return -1;
            return a.name.localeCompare(b.name);
        });
        if (SPECIAL_TAG_COLORS.hasOwnProperty(wanted) && !categories.some((c) => c.name === wanted)) {
            categories.push({ name: wanted });
        }
        selected = categories.some((c) => c.name === wanted) ? wanted : (categories[0]?.name ?? '');

        const defaultNames = new Set(defaults.map((c) => c.name));
        const customNames = new Set(custom.map((c) => c.name));
        const tagsHtml = categories.map((cat) => `
            <div class="tag-btn-wrap">
                <button type="button" class="tag-btn${cat.name === selected ? ' selected' : ''}" data-tag="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</button>
                ${customNames.has(cat.name) && !defaultNames.has(cat.name) ? `<span class="tag-delete-x" data-tag="${escapeHtml(cat.name)}" title="Delete category">✕</span>` : ''}
            </div>
        `).join('');

        const addHtml = adding
            ? `<div class="tag-btn-wrap tag-add-wrap">
                   <input type="text" class="tag-add-input" maxlength="24" placeholder="New category">
                   <button type="button" class="tag-add-confirm" title="Add">✓</button>
               </div>`
            : `<button type="button" class="tag-btn tag-add-btn" title="Add a new category">+ Add</button>`;

        container.innerHTML = tagsHtml + addHtml;

        if (adding) container.querySelector('.tag-add-input').focus();
    }

    async function commitNewTag() {
        const input = container.querySelector('.tag-add-input');
        const name = input ? input.value.trim() : '';
        adding = false;

        if (!name) {
            await render(selected);
            return;
        }

        const custom = await loadList(storageKey);
        const isDuplicate = [...defaults, ...custom].some((c) => c.name.toLowerCase() === name.toLowerCase());
        if (isDuplicate) {
            await render(name);
            return;
        }

        const color = NEW_TAG_PALETTE[custom.length % NEW_TAG_PALETTE.length];
        custom.push({ name, color });
        await saveList(storageKey, custom);
        await render(name);
        onChange();
    }

    container.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.tag-delete-x');
        if (deleteBtn) {
            const custom = await loadList(storageKey);
            const index = custom.findIndex((c) => c.name === deleteBtn.dataset.tag);
            if (index === -1) return;

            const [removed] = custom.splice(index, 1);
            await saveList(storageKey, custom);
            await render(selected);
            onChange();
            showUndoToast('Category deleted.', async () => {
                const current = await loadList(storageKey);
                current.splice(Math.min(index, current.length), 0, removed);
                await saveList(storageKey, current);
                await render(selected);
                onChange();
            });
            return;
        }

        if (e.target.closest('.tag-add-btn')) {
            adding = true;
            await render(selected);
            return;
        }

        if (e.target.closest('.tag-add-confirm')) {
            await commitNewTag();
            return;
        }

        const tagBtn = e.target.closest('.tag-btn:not(.tag-add-btn)');
        if (tagBtn) {
            selected = tagBtn.dataset.tag;
            container.querySelectorAll('.tag-btn').forEach((b) => b.classList.toggle('selected', b === tagBtn));
        }
    });

    container.addEventListener('keydown', (e) => {
        if (!e.target.classList.contains('tag-add-input')) return;
        if (e.key === 'Enter') { e.preventDefault(); commitNewTag(); }
        if (e.key === 'Escape') { adding = false; render(selected); }
    });

    container.addEventListener('focusout', (e) => {
        if (!e.target.classList.contains('tag-add-input')) return;
        setTimeout(() => {
            if (adding && !container.contains(document.activeElement)) {
                adding = false;
                render(selected);
            }
        }, 150);
    });

    return { render, get selected() { return selected; } };
}

function addSubscriptionInterval(dateString, frequency, dayOfMonth) {
    const d = new Date(dateString + 'T00:00:00');
    d.setMonth(d.getMonth() + (frequency === 'yearly' ? 12 : 1), 1);
    d.setDate(Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return getLocalISO(d);
}

let subscriptionQueue = Promise.resolve();
function processSubscriptionPayments() {
    const result = subscriptionQueue.then(runSubscriptionPayments);
    subscriptionQueue = result.catch(() => {});
    return result;
}

async function runSubscriptionPayments() {
    const subscriptions = await loadSubscriptions();
    if (!subscriptions.length) return { count: 0, total: 0, names: [] };

    const today = todayISO();
    const purchases = await loadPurchases();
    let count = 0;
    let total = 0;
    const names = [];

    subscriptions.forEach((sub) => {
        if (!sub.amount || !sub.startDate) return;

        const dayOfMonth = new Date(sub.startDate + 'T00:00:00').getDate();
        let nextBilling = sub.nextBillingDate || sub.startDate;
        let charged = 0;

        while (nextBilling <= today) {
            purchases.push({
                id: newId(),
                amount: sub.amount,
                description: sub.name || 'Subscription',
                tag: 'Subscription',
                date: nextBilling,
                fromSurplus: true,
                isSubscriptionPayment: true,
                subscriptionId: sub.id
            });
            charged += 1;
            total += Number(sub.amount) || 0;
            nextBilling = addSubscriptionInterval(nextBilling, sub.frequency, dayOfMonth);
        }

        if (charged) names.push(sub.name);
        count += charged;
        sub.nextBillingDate = nextBilling;
    });

    if (count) {
        await savePurchases(purchases);
        await saveSubscriptions(subscriptions);
    }
    return { count, total, names };
}

function getFinancialStats() {
    financialStatsCache ??= computeFinancialStats().catch((err) => {
        financialStatsCache = null;
        throw err;
    });
    return financialStatsCache;
}

async function computeFinancialStats() {
    const setupResponse = await window.electronAPI.getUserData('financial_setup');
    if (!setupResponse.success || !setupResponse.value) return null;

    const data = setupResponse.value;
    const [purchases, incomeEntries] = await Promise.all([loadPurchases(), loadIncome()]);
    const todayStr = todayISO();
    const isBeforeStart = todayStr < data.startDate;
    const isBreak = isBeforeStart || todayStr > data.endDate;
    const months = daysBetween(data.startDate, data.endDate) / 30.44;

    const start = new Date(data.startDate + 'T00:00:00');
    const end = new Date(data.endDate + 'T00:00:00');
    const now = new Date(todayStr + 'T00:00:00');
    const effectiveStart = now > start ? now : start;
    const daysRemaining = Math.max(0, Math.round((end - effectiveStart) / (1000 * 60 * 60 * 24)) + 1);

    const totalIn = (data.checkingSavings || 0) + (data.financialAidRefund || 0) + (data.parentContribution || 0)
        + incomeEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const totalOut = (data.rentUtilities || 0) * months + (data.oneTimeExpenses || 0);
    const netRemaining = totalIn - totalOut;

    const semesterPurchases = purchases.filter((p) => p.date >= data.startDate && p.date <= data.endDate);
    const dailyFunded = semesterPurchases.filter((p) => !isSurplusFunded(p));
    const totalSpent = sumNet(dailyFunded);
    const totalSpentBeforeToday = sumNet(dailyFunded.filter((p) => p.date < todayStr));
    const totalSpentOnGoals = sumNet(semesterPurchases.filter(isSurplusFunded));
    const totalPendingReimbursements = semesterPurchases.reduce((sum, p) => sum + pendingReimbursement(p), 0);

    const currentNetRunway = netRemaining - totalSpent - totalSpentOnGoals;
    const runwayRemainingPercent = netRemaining > 0 ? Math.max(0, (currentNetRunway / netRemaining) * 100) : 0;

    const weightFactor = data.weekendWeight || 1;
    const fullWeight = calculateWeightRange(start, end, weightFactor);
    const baseSpendUnit = fullWeight > 0 ? netRemaining / fullWeight : 0;
    const roundedWeekday = Math.round(baseSpendUnit);
    const roundedWeekend = Math.round(baseSpendUnit * weightFactor);
    const dayLimit = (d) => (isBoostDay(d) ? roundedWeekend : roundedWeekday);

    let expectedSpendToDate = 0;
    for (const d = new Date(start); d < effectiveStart && d <= end; d.setDate(d.getDate() + 1)) {
        expectedSpendToDate += dayLimit(d);
    }

    const surplusDeficit = expectedSpendToDate - totalSpentBeforeToday - totalSpentOnGoals;

    return {
        data, purchases, incomeEntries, todayStr, isBeforeStart, isBreak, daysRemaining,
        netRemaining, totalSpent, totalPendingReimbursements, currentNetRunway, runwayRemainingPercent,
        weightFactor, roundedWeekday, roundedWeekend, dayLimit,
        dailySafeSpend: data.noFixedBudget ? null : dayLimit(now),
        surplusDeficit,
        isSurplus: surplusDeficit >= 0
    };
}

function setupPurchaseUI({ refresh, onLogged = () => {} }) {
    const byId = (id) => document.getElementById(id);
    const overlay = byId('purchaseModalOverlay');
    const titleText = byId('purchaseModalTitleText');
    const amountInput = byId('purchaseAmount');
    const descriptionInput = byId('purchaseDescription');
    const dateInput = byId('purchaseDate');
    const fundSourceField = byId('fundSourceField');
    const fundSourceGroup = byId('fundSourceGroup');
    const fundSourceNote = byId('fundSourceNote');
    const splitToggle = byId('purchaseSplitToggle');
    const reimbursementField = byId('reimbursementField');
    const reimbursementInput = byId('purchaseReimbursement');
    const purchaseError = byId('purchaseError');
    const submitBtn = byId('submitPurchaseBtn');
    const oneTimeFields = byId('oneTimePurchaseFields');
    const subscriptionToggleBtn = byId('subscriptionToggleBtn');
    const subscriptionSection = byId('subscriptionSection');
    const subscriptionList = byId('subscriptionListContainer');
    const subscriptionName = byId('subscriptionName');
    const subscriptionAmount = byId('subscriptionAmount');
    const subscriptionFrequency = byId('subscriptionFrequency');
    const subscriptionStart = byId('subscriptionStartDate');
    const subscriptionError = byId('subscriptionError');
    const saveSubscriptionBtn = byId('saveSubscriptionBtn');

    const tagPicker = createTagPicker(byId('purchaseTags'), DEFAULT_CATEGORIES, 'custom_categories', refresh);
    let editingId = null;
    let fundSource = 'daily';

    function setFundSource(source) {
        fundSource = source;
        fundSourceGroup.querySelectorAll('.tag-btn').forEach((btn) => btn.classList.toggle('selected', btn.dataset.source === source));
    }

    function setSplit(on, value = '') {
        splitToggle.checked = on;
        reimbursementField.style.display = on ? 'block' : 'none';
        reimbursementInput.value = on ? value : '';
    }

    function setSubscriptionExpanded(expanded) {
        subscriptionSection.classList.toggle('collapsed', !expanded);
        oneTimeFields.classList.toggle('collapsed', expanded);
        subscriptionToggleBtn.innerText = expanded ? '− Hide subscription setup' : '+ Set up a subscription';
    }

    function resetSubscriptionForm() {
        subscriptionError.innerText = '';
        subscriptionName.value = '';
        subscriptionAmount.value = '';
        subscriptionFrequency.value = 'monthly';
        subscriptionStart.value = '';
    }

    async function refreshFundSourceInfo() {
        const stats = await getFinancialStats();
        const noBudget = !!stats?.data.noFixedBudget;
        fundSourceField.style.display = noBudget ? 'none' : 'block';

        if (!stats || stats.isBreak || noBudget) {
            fundSourceNote.innerText = '';
        } else if (stats.isSurplus) {
            fundSourceNote.innerText = `You currently have ${formatWhole(stats.surplusDeficit)} in surplus available.`;
        } else {
            fundSourceNote.innerText = `You're currently ${formatWhole(Math.abs(stats.surplusDeficit))} in deficit — drawing from surplus isn't recommended right now.`;
        }
    }

    async function renderSubscriptionList() {
        const subscriptions = await loadSubscriptions();
        subscriptionList.innerHTML = subscriptions.map((sub) => `
            <div class="subscription-row" data-id="${sub.id}">
                <div class="subscription-row-info">
                    <span class="subscription-row-name">${escapeHtml(sub.name)}</span>
                    <span class="subscription-row-meta">${formatCurrency(sub.amount)} / ${sub.frequency === 'yearly' ? 'year' : 'month'}</span>
                </div>
                <button type="button" class="delete-purchase-btn subscription-delete-btn" data-id="${sub.id}" aria-label="Remove subscription" title="Remove this subscription">✕</button>
            </div>
        `).join('');
    }

    async function openModal(purchase = null) {
        editingId = purchase?.id ?? null;
        purchaseError.innerText = '';
        titleText.innerText = purchase ? 'Edit Purchase' : 'Log a Purchase';
        submitBtn.innerText = purchase ? 'Save Changes' : 'Log Purchase';
        amountInput.value = purchase ? purchase.amount : '';
        descriptionInput.value = purchase ? purchase.description : '';
        dateInput.value = purchase ? purchase.date : todayISO();
        dateInput.max = todayISO();
        setSplit(!!purchase?.reimbursement, purchase?.reimbursement);
        setFundSource(purchase?.fromSurplus ? 'surplus' : 'daily');
        resetSubscriptionForm();
        setSubscriptionExpanded(false);
        refreshFundSourceInfo();
        await Promise.all([tagPicker.render(purchase?.tag), renderSubscriptionList()]);
        overlay.classList.add('visible');
    }

    function closeModal() {
        overlay.classList.remove('visible');
        editingId = null;
    }

    fundSourceGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.tag-btn');
        if (btn && !btn.disabled) setFundSource(btn.dataset.source);
    });

    splitToggle.addEventListener('change', () => setSplit(splitToggle.checked));
    subscriptionToggleBtn.addEventListener('click', () => setSubscriptionExpanded(subscriptionSection.classList.contains('collapsed')));
    byId('closePurchaseModalBtn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    subscriptionList.addEventListener('click', async (e) => {
        const btn = e.target.closest('.subscription-delete-btn');
        if (!btn) return;

        const subscriptions = await loadSubscriptions();
        const index = subscriptions.findIndex((s) => s.id === btn.dataset.id);
        if (index === -1) return;

        const [removed] = subscriptions.splice(index, 1);
        await saveSubscriptions(subscriptions);
        await renderSubscriptionList();
        showUndoToast('Subscription removed.', async () => {
            const current = await loadSubscriptions();
            current.splice(Math.min(index, current.length), 0, removed);
            await saveSubscriptions(current);
            await renderSubscriptionList();
        });
    });

    saveSubscriptionBtn.addEventListener('click', async () => {
        const name = subscriptionName.value.trim();
        const amount = Number(subscriptionAmount.value);
        const startDate = subscriptionStart.value || todayISO();

        if (!name) {
            subscriptionError.innerText = 'Add a name for this subscription.';
            return;
        }
        if (!(amount > 0)) {
            subscriptionError.innerText = `Enter an amount greater than ${getCurrencySymbol()}0.`;
            return;
        }

        saveSubscriptionBtn.disabled = true;
        saveSubscriptionBtn.innerText = 'Saving...';

        const subscriptions = await loadSubscriptions();
        subscriptions.push({ id: newId(), name, amount, frequency: subscriptionFrequency.value, startDate, nextBillingDate: startDate });
        await saveSubscriptions(subscriptions);
        await processSubscriptionPayments();

        resetSubscriptionForm();
        saveSubscriptionBtn.disabled = false;
        saveSubscriptionBtn.innerText = 'Add Subscription';
        await renderSubscriptionList();
        refresh();
    });

    submitBtn.addEventListener('click', async () => {
        const amount = Number(amountInput.value);
        const description = descriptionInput.value.trim();
        const date = dateInput.value;
        const isSplit = splitToggle.checked;
        const reimbursement = isSplit ? Number(reimbursementInput.value) : 0;
        const symbol = getCurrencySymbol();

        const error = !(amount > 0) ? `Enter an amount greater than ${symbol}0.`
            : !description ? 'Add a short description.'
            : !date ? 'Pick a date.'
            : date > todayISO() ? 'Date cannot be in the future.'
            : isSplit && !(reimbursement > 0 && reimbursement < amount) ? `Reimbursement must be greater than ${symbol}0 and less than total amount.`
            : '';
        purchaseError.innerText = error;
        if (error) return;

        const id = editingId;
        const fromSurplus = fundSource === 'surplus';
        submitBtn.disabled = true;
        submitBtn.innerText = 'Saving...';

        const purchases = await loadPurchases();

        if (id) {
            const existing = purchases.find((p) => p.id === id);
            if (existing) {
                Object.assign(existing, { amount, description, date, tag: tagPicker.selected, fromSurplus });
                delete existing.liabilityId;
                if (isSplit) {
                    if (!existing.reimbursement) existing.reimbursementSettled = false;
                    existing.reimbursement = reimbursement;
                } else {
                    delete existing.reimbursement;
                    delete existing.reimbursementSettled;
                }
            }
        } else {
            purchases.push({
                id: newId(),
                amount,
                description,
                tag: tagPicker.selected,
                date,
                reimbursement: reimbursement || undefined,
                reimbursementSettled: false,
                fromSurplus
            });
        }
        await savePurchases(purchases);

        submitBtn.disabled = false;
        closeModal();
        refresh();
        if (!id) onLogged();
    });

    document.addEventListener('click', async (e) => {
        if (e.target.closest('#logPurchaseBtn')) return openModal();

        const btn = e.target.closest('.edit-purchase-btn, .delete-purchase-btn:not(.subscription-delete-btn)');
        if (!btn) return;

        const purchases = await loadPurchases();
        const index = purchases.findIndex((p) => p.id === btn.dataset.id);
        if (index === -1) return;
        if (btn.classList.contains('edit-purchase-btn')) return openModal(purchases[index]);

        const [removed] = purchases.splice(index, 1);
        await savePurchases(purchases);
        refresh();
        showUndoToast('Purchase deleted.', async () => {
            const current = await loadPurchases();
            current.splice(index, 0, removed);
            await savePurchases(current);
            refresh();
        });
    });

    document.addEventListener('change', async (e) => {
        if (!e.target.matches('.settle-reimbursement-chk') || !e.target.checked) return;

        const purchases = await loadPurchases();
        const item = purchases.find((p) => p.id === e.target.dataset.id);
        if (!item) return;

        item.reimbursementSettled = true;
        await savePurchases(purchases);
        refresh();
    });
}

document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="purchaseModalOverlay">
        <div class="modal-card">
            <div class="modal-header">
                <span class="modal-title" id="purchaseModalTitleText">Log a Purchase</span>
                <button class="modal-close-btn" id="closePurchaseModalBtn">✕</button>
            </div>

            <div class="collapsible-section" id="oneTimePurchaseFields">
                <div class="field">
                    <label for="purchaseAmount">Amount</label>
                    <div class="dollar-input">
                        <span class="dollar-sign">$</span>
                        <input type="number" id="purchaseAmount" min="0" step="0.01" placeholder="0.00">
                    </div>
                </div>

                <div class="field">
                    <label for="purchaseDescription">What was it?</label>
                    <input type="text" id="purchaseDescription" placeholder="Coffee, groceries...">
                </div>

                <div class="field">
                    <label for="purchaseDate">Date</label>
                    <input type="date" id="purchaseDate">
                </div>

                <div class="field">
                    <label>Category</label>
                    <div class="tag-group" id="purchaseTags"></div>
                </div>

                <div class="field" id="fundSourceField">
                    <label>Fund This With</label>
                    <div class="tag-group" id="fundSourceGroup">
                        <button type="button" class="tag-btn selected" data-source="daily">Daily Budget</button>
                        <button type="button" class="tag-btn" data-source="surplus">Surplus</button>
                    </div>
                    <p class="category-limit-note" id="fundSourceNote"></p>
                </div>

                <div class="field-checkbox">
                    <input type="checkbox" id="purchaseSplitToggle">
                    <label for="purchaseSplitToggle">Split this purchase</label>
                </div>

                <div class="field" id="reimbursementField" style="display: none;">
                    <label for="purchaseReimbursement">Expected Reimbursement</label>
                    <div class="dollar-input">
                        <span class="dollar-sign">$</span>
                        <input type="number" id="purchaseReimbursement" min="0" step="0.01" placeholder="0.00">
                    </div>
                </div>

                <p class="inline-warning" id="purchaseError"></p>

                <button class="modal-submit-btn" id="submitPurchaseBtn">Log Purchase</button>
            </div>

            <button class="steady-income-toggle" id="subscriptionToggleBtn" type="button">+ Set up a subscription</button>

            <div class="steady-income-section collapsible-section collapsed" id="subscriptionSection">
                <div class="steady-income-title-row">
                    <p class="steady-income-desc">Have a recurring subscription, like a gym membership? Set it once and it'll auto-charge itself on the billing date.</p>
                </div>

                <div id="subscriptionListContainer"></div>

                <div class="field">
                    <label for="subscriptionName">Subscription Name</label>
                    <input type="text" id="subscriptionName" placeholder="Spotify, gym membership...">
                </div>

                <div class="field-row">
                    <div class="field">
                        <label for="subscriptionAmount">Amount</label>
                        <div class="dollar-input">
                            <span class="dollar-sign">$</span>
                            <input type="number" id="subscriptionAmount" min="0" step="0.01" placeholder="0.00">
                        </div>
                    </div>
                    <div class="field">
                        <label for="subscriptionFrequency">Billed</label>
                        <select id="subscriptionFrequency">
                            <option value="monthly">Monthly</option>
                            <option value="yearly">Yearly</option>
                        </select>
                    </div>
                </div>

                <div class="field">
                    <label for="subscriptionStartDate">First Billing Date <span class="field-hint">(next one auto-charges on schedule)</span></label>
                    <input type="date" id="subscriptionStartDate">
                </div>

                <p class="inline-warning" id="subscriptionError"></p>

                <button class="modal-submit-btn" id="saveSubscriptionBtn">Add Subscription</button>
            </div>
        </div>
    </div>

    <div id="undoToast" class="undo-toast">
        <span></span>
        <button id="undoBtn">Undo</button>
    </div>

    <div id="globalTooltip" class="global-tooltip"></div>
`);

document.querySelectorAll('.dollar-sign').forEach((el) => {
    el.textContent = getCurrencySymbol();
});

document.getElementById('undoBtn').addEventListener('click', async () => {
    const action = undoAction;
    hideUndoToast();
    await action?.();
});

document.addEventListener('mousemove', (e) => {
    const tooltip = document.getElementById('globalTooltip');
    const slice = e.target.closest('.pie-slice');
    if (!slice) {
        tooltip.classList.remove('show');
        return;
    }
    tooltip.innerHTML = `<strong>${escapeHtml(slice.dataset.desc)}</strong><br/>${escapeHtml(slice.dataset.tag)} - ${formatCurrency(slice.dataset.amount)}`;
    tooltip.style.left = `${e.clientX + 15}px`;
    tooltip.style.top = `${e.clientY + 15}px`;
    tooltip.classList.add('show');
});
