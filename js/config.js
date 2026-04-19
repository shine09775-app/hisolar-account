const SUPABASE_URL = 'https://lkigvtctvajgnpctrsyp.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxraWd2dGN0dmFqZ25wY3Ryc3lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1Mzg5NjgsImV4cCI6MjA5MjExNDk2OH0.O6B2r0O9eD0y5lM9w702M8B4kGXWYrbHaPtyibMTS8g'

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ---- Passcode (โครงสร้างรองรับอนาคต) ----
const Auth = {
  SESSION_KEY: 'hisolar_auth',

  async isEnabled() {
    const { data } = await db.from('app_settings')
      .select('value').eq('key', 'passcode_enabled').single()
    return data?.value === 'true'
  },

  async verify(input) {
    const { data } = await db.from('app_settings')
      .select('value').eq('key', 'passcode_hash').single()
    const hash = await Auth._sha256(input)
    return hash === data?.value
  },

  setSession() {
    sessionStorage.setItem(Auth.SESSION_KEY, '1')
  },

  hasSession() {
    return sessionStorage.getItem(Auth.SESSION_KEY) === '1'
  },

  async guard() {
    const enabled = await Auth.isEnabled()
    if (!enabled) return true
    if (Auth.hasSession()) return true
    window.location.href = 'login.html'
    return false
  },

  async _sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
}
