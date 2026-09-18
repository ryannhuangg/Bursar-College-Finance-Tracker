const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://jdgrwlxstdzgwrhiaonw.supabase.co/';
const SUPABASE_ANON_KEY = 'sb_publishable_7cnTpTElvfwHg5ntibQlNw_ntBGVv8k';
const WebSocket = require('ws');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
        transport: WebSocket
    }
});

const PROTOCOL = 'collegefinance';

let mainWindow;

function getSessionFilePath() {
    return path.join(app.getPath('userData'), 'session.json');
}

function saveSession(session) {
    try {
        fs.writeFileSync(getSessionFilePath(), JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token
        }));
    } catch (err) {
        console.error('Failed to save session:', err);
    }
}

function loadSession() {
    try {
        const raw = fs.readFileSync(getSessionFilePath(), 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        return null;
    }
}

function clearSession() {
    try {
        fs.unlinkSync(getSessionFilePath());
    } catch (err) {
    }
}

if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient(PROTOCOL);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL}://`));
        if (url) handleAuthCallback(url);

        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleAuthCallback(url);
    });

    function createWindow(startPage = 'index.html') {
        mainWindow = new BrowserWindow({
            width: 800,
            height: 600,
            backgroundColor: '#0a0a0c',
            titleBarStyle: 'hidden',
            titleBarOverlay: {
                color: '#0a0a0c',
                symbolColor: '#ffffff',
                height: 32
            },
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        mainWindow.loadFile(startPage);
    }

    ipcMain.handle('get-user-data', async (event, key) => {
        try {
            const { data: userData, error: userError } = await supabase.auth.getUser();
            if (userError || !userData?.user) {
                return { success: false, error: 'Not signed in.' };
            }

            const { data, error } = await supabase
                .from('user_data')
                .select('value')
                .eq('user_id', userData.user.id)
                .eq('key', key)
                .maybeSingle();

            if (error) return { success: false, error: error.message };
            return { success: true, value: data ? data.value : null };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('set-user-data', async (event, { key, value }) => {
        try {
            const { data: userData, error: userError } = await supabase.auth.getUser();
            if (userError || !userData?.user) {
                return { success: false, error: 'Not signed in.' };
            }

            const { error } = await supabase
                .from('user_data')
                .upsert({
                    user_id: userData.user.id,
                    key,
                    value,
                    updated_at: new Date().toISOString()
                });

            if (error) return { success: false, error: error.message };
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('get-current-user', async () => {
        try {
            const { data, error } = await supabase.auth.getUser();
            if (error || !data?.user) {
                return { success: false, error: error ? error.message : 'No active session.' };
            }
            return { success: true, user: data.user };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('supabase-signout', async () => {
        try {
            const { error } = await supabase.auth.signOut();
            clearSession();
            if (error) return { success: false, error: error.message };
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.on('navigate-to-page', (event, pageName) => {
        mainWindow.loadFile(pageName);
    });

    ipcMain.handle('supabase-signup', async (event, { firstName, lastName, email, password }) => {
        try {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        first_name: firstName,
                        last_name: lastName,
                        full_name: `${firstName} ${lastName}`
                    }
                }
            });
            if (error) return { success: false, error: error.message };
            return { success: true, user: data.user };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('supabase-login', async (event, { email, password, rememberMe }) => {
        try {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) return { success: false, error: error.message };

            if (rememberMe && data.session) {
                saveSession(data.session);
            } else {
                clearSession();
            }

            return { success: true, user: data.user };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    let googleAuthIntent = 'login';

    ipcMain.on('supabase-google-login', async (event, intent) => {
        googleAuthIntent = intent === 'signup' ? 'signup' : 'login';

        if (mainWindow) {
            mainWindow.webContents.send('google-auth-status', {
                status: 'pending',
                message: 'Signing in with Google...'
            });
        }

        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${PROTOCOL}://callback`
            }
        });

        if (error) {
            if (mainWindow) {
                mainWindow.webContents.send('google-auth-status', {
                    status: 'error',
                    message: error.message
                });
            }
            return;
        }

        if (data?.url) {
            shell.openExternal(data.url);
        }
    });

    async function handleAuthCallback(url) {
        try {
            const parsedUrl = new URL(url);
            const fragment = parsedUrl.hash.startsWith('#') ? parsedUrl.hash.slice(1) : parsedUrl.hash;
            const params = new URLSearchParams(fragment);

            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');

            if (!accessToken || !refreshToken) {
                console.error('Auth callback did not include tokens:', url);
                if (mainWindow) {
                    mainWindow.webContents.send('google-auth-status', {
                        status: 'error',
                        message: 'Google sign-in failed. Please try again.'
                    });
                }
                return;
            }

            const { error } = await supabase.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken
            });

            if (error) {
                console.error('Failed to set Supabase session:', error.message);
                if (mainWindow) {
                    mainWindow.webContents.send('google-auth-status', {
                        status: 'error',
                        message: error.message
                    });
                }
                return;
            }

            if (googleAuthIntent === 'login') {
                saveSession({ access_token: accessToken, refresh_token: refreshToken });
            }

            if (mainWindow) {
                const destination = googleAuthIntent === 'signup' ? 'login.html' : 'dashboard.html';
                const message = googleAuthIntent === 'signup'
                    ? 'Success! Directing to login...'
                    : 'Success! Loading dashboard...';
                const delay = googleAuthIntent === 'signup' ? 1500 : 2000;

                mainWindow.webContents.send('google-auth-status', {
                    status: 'success',
                    message
                });

                setTimeout(() => {
                    if (mainWindow) mainWindow.loadFile(destination);
                }, delay);
            }
        } catch (err) {
            console.error('Failed to handle auth callback:', err);
            if (mainWindow) {
                mainWindow.webContents.send('google-auth-status', {
                    status: 'error',
                    message: 'Something went wrong signing in with Google.'
                });
            }
        }
    }

    app.whenReady().then(async () => {
        let startPage = 'index.html';
        const savedSession = loadSession();

        if (savedSession) {
            const { data, error } = await supabase.auth.setSession({
                access_token: savedSession.access_token,
                refresh_token: savedSession.refresh_token
            });

            if (!error && data?.session) {
                startPage = 'dashboard.html';
            } else {
                clearSession();
            }
        }

        createWindow(startPage);

        const initialUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
        if (initialUrl) handleAuthCallback(initialUrl);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (!loadSession()) {
            supabase.auth.signOut();
        }
        if (process.platform !== 'darwin') app.quit();
    });
}
