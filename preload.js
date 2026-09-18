const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    changePage: (pageName) => ipcRenderer.send('navigate-to-page', pageName),
    
    attemptSignup: (firstName, lastName, email, password) => ipcRenderer.invoke('supabase-signup', { firstName, lastName, email, password }),
    
    attemptLogin: (email, password, rememberMe) => ipcRenderer.invoke('supabase-login', { email, password, rememberMe }),

    getCurrentUser: () => ipcRenderer.invoke('get-current-user'),

    getUserData: (key) => ipcRenderer.invoke('get-user-data', key),

    setUserData: (key, value) => ipcRenderer.invoke('set-user-data', { key, value }),

    signOut: () => ipcRenderer.invoke('supabase-signout'),
    
    startGoogleAuth: (intent) => ipcRenderer.send('supabase-google-login', intent),

    updateEmail: (newEmail) => ipcRenderer.invoke('update-email', { newEmail }),

    updatePassword: (newPassword) => ipcRenderer.invoke('update-password', { newPassword }),

    wipeUserData: () => ipcRenderer.invoke('wipe-user-data'),

    deleteAccount: () => ipcRenderer.invoke('delete-account'),

    onGoogleAuthStatus: (callback) => ipcRenderer.on('google-auth-status', (event, payload) => callback(payload))
});