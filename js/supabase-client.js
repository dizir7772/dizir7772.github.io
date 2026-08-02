/* ===== Supabase data layer ===== */

const SUPABASE_URL = 'https://pcrhmstckwnabwtdbtsa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBjcmhtc3Rja3duYWJ3dGRidHNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NzI0NzUsImV4cCI6MjEwMTE0ODQ3NX0.1yUFN_ihY8ywYS_dLyoMMokLdhKIXTSdW4Vn38ErAWU';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- Auth ---------- */
async function sbSignUp(email, password, role, fullName){
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { role, full_name: fullName } }
  });
  if(error) throw error;
  return data;
}
async function sbSignIn(email, password){
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error) throw error;
  return data;
}
async function sbSignOut(){
  await sb.auth.signOut();
}
async function sbGetSession(){
  const { data } = await sb.auth.getSession();
  return data.session;
}
async function sbGetProfile(userId){
  const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
  if(error) throw error;
  return data;
}

/* ---------- Readings ---------- */
async function sbLoadReadings(patientId){
  const { data, error } = await sb.from('readings')
    .select('t,mgdl,dev')
    .eq('patient_id', patientId)
    .order('t', { ascending: true });
  if(error) throw error;
  return data.map(r => ({ t: Number(r.t), mgdl: r.mgdl, mmol: mgdlToMmol(r.mgdl), dev: r.dev }));
}

// upsert in chunks to avoid overly large single requests
async function sbSaveReadings(patientId, readings){
  const CHUNK = 500;
  const rows = readings.map(r => ({ patient_id: patientId, t: r.t, mgdl: r.mgdl, dev: r.dev || null }));
  for(let i=0; i<rows.length; i+=CHUNK){
    const chunk = rows.slice(i, i+CHUNK);
    const { error } = await sb.from('readings').upsert(chunk, { onConflict: 'patient_id,t,dev' });
    if(error) throw error;
  }
}

/* ---------- Device colors ---------- */
async function sbLoadDeviceColors(patientId){
  const { data, error } = await sb.from('device_colors').select('device_id,color_key').eq('patient_id', patientId);
  if(error) throw error;
  const map = {};
  for(const row of data) map[row.device_id] = row.color_key;
  return map;
}
async function sbSaveDeviceColor(patientId, deviceId, colorKey){
  if(colorKey === null){
    const { error } = await sb.from('device_colors').delete().eq('patient_id', patientId).eq('device_id', deviceId);
    if(error) throw error;
    return;
  }
  const { error } = await sb.from('device_colors')
    .upsert({ patient_id: patientId, device_id: deviceId, color_key: colorKey }, { onConflict: 'patient_id,device_id' });
  if(error) throw error;
}

/* ---------- Doctor access ---------- */
async function sbInviteDoctor(patientId, doctorEmail){
  const { data: doctorProfile, error: findErr } = await sb.from('profiles')
    .select('id,email,full_name').eq('role','doctor').ilike('email', doctorEmail.trim()).maybeSingle();
  if(findErr) throw findErr;
  if(!doctorProfile) throw new Error('Лікаря з такою поштою не знайдено. Попросіть лікаря спочатку зареєструватись у системі.');
  const { error } = await sb.from('doctor_access')
    .upsert({ patient_id: patientId, doctor_id: doctorProfile.id, status: 'accepted' }, { onConflict: 'patient_id,doctor_id' });
  if(error) throw error;
  return doctorProfile;
}
async function sbListMyDoctors(patientId){
  const { data, error } = await sb.from('doctor_access')
    .select('id, doctor_id, status, profiles!doctor_access_doctor_id_fkey(email, full_name)')
    .eq('patient_id', patientId).eq('status','accepted');
  if(error) throw error;
  return data;
}
async function sbRevokeDoctor(accessId){
  const { error } = await sb.from('doctor_access').update({ status:'revoked' }).eq('id', accessId);
  if(error) throw error;
}
async function sbListMyPatients(doctorId){
  const { data, error } = await sb.from('doctor_access')
    .select('id, patient_id, profiles!doctor_access_patient_id_fkey(email, full_name)')
    .eq('doctor_id', doctorId).eq('status','accepted');
  if(error) throw error;
  return data;
}
