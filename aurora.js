(function () {
    document.querySelectorAll('.aurora-layer').forEach((layer) => {
        const durationStr = getComputedStyle(layer).animationDuration;
        const durationMs = parseFloat(durationStr) * 1000;
        if (!durationMs) return;

        const cycleMs = durationMs * 2;
        const elapsed = Date.now() % cycleMs;

        layer.style.animationDelay = `-${elapsed}ms`;
        layer.style.animationPlayState = 'running';
    });
})();
