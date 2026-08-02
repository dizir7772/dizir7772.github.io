(function(){
  let CURRENT_USER = null;
  let CURRENT_PROFILE = null;

  async function boot(){
    let session;
    try{ session = await sbGetSession(); }catch(e){ session = null; }
    if(!session){ window.location.href = 'index.html'; return; }
    CURRENT_USER = session.user;

    try{
      CURRENT_PROFILE = await sbGetProfile(CURRENT_USER.id);
    }catch(e){
      alert('Не вдалося завантажити профіль: ' + e.message);
      window.location.href = 'index.html';
      return;
    }
    if(CURRENT_PROFILE.role !== 'patient'){
      window.location.href = 'doctor.html';
      return;
    }

    document.getElementById('patientNameTitle').textContent = CURRENT_PROFILE.full_name || CURRENT_PROFILE.email;

    CAN_EDIT = true;
    ON_SAVE_DEVICE_COLOR = async (dev, colorKey) => {
      await sbSaveDeviceColor(CURRENT_USER.id, dev, colorKey);
    };
    ON_SAVE_READINGS = async (newReadings) => {
      await sbSaveReadings(CURRENT_USER.id, newReadings);
    };

    try{
      const [readings, colors] = await Promise.all([
        sbLoadReadings(CURRENT_USER.id),
        sbLoadDeviceColors(CURRENT_USER.id)
      ]);
      DEVICE_COLORS = colors;
      FULL_HISTORY = readings;
    }catch(e){
      console.error(e);
      alert('Не вдалося завантажити дані з хмари: ' + e.message);
      FULL_HISTORY = [];
    }

    if(FULL_HISTORY.length === 0){
      document.getElementById('heroSection').insertAdjacentHTML('beforebegin',
        '<div class="empty-state card"><p style="font-size:16px;color:var(--ink);margin-bottom:8px;">Ще немає жодного виміру</p><p>Завантаж CSV-файл сенсора кнопкою "⇪ Завантажити новий файл" вгорі, щоб побачити дашборд.</p></div>');
    }

    applyDeviceFilterAndRender();
    initCollapsibleCards();
    loadDoctorsList();
  }

  document.getElementById('logoutBtn').addEventListener('click', async ()=>{
    await sbSignOut();
    window.location.href = 'index.html';
  });

  document.getElementById('fileInput').addEventListener('change', e=>{
    if(e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = '';
  });
  const dropZoneEl = document.getElementById('dropZone');
  dropZoneEl.addEventListener('click', ()=>document.getElementById('fileInput').click());
  dropZoneEl.addEventListener('dragover', e=>{e.preventDefault(); dropZoneEl.classList.add('dragover');});
  dropZoneEl.addEventListener('dragleave', ()=>dropZoneEl.classList.remove('dragover'));
  dropZoneEl.addEventListener('drop', e=>{
    e.preventDefault(); dropZoneEl.classList.remove('dragover');
    if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  const uploadBtnTop = document.getElementById('uploadBtnTop');
  uploadBtnTop.addEventListener('dragover', e=>{e.preventDefault(); uploadBtnTop.classList.add('dragover');});
  uploadBtnTop.addEventListener('dragleave', ()=>uploadBtnTop.classList.remove('dragover'));
  uploadBtnTop.addEventListener('drop', e=>{
    e.preventDefault(); uploadBtnTop.classList.remove('dragover');
    if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  document.body.addEventListener('dragover', e=>e.preventDefault());
  document.body.addEventListener('drop', e=>{
    e.preventDefault();
    if(e.target.closest('.card') === null && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  document.getElementById('backupExportBtn').addEventListener('click', exportBackup);
  document.getElementById('backupImportBtn').addEventListener('click', ()=>document.getElementById('backupFileInput').click());
  document.getElementById('backupFileInput').addEventListener('change', e=>{
    if(e.target.files[0]) handleBackupFileCloud(e.target.files[0]);
    e.target.value = '';
  });

  function handleBackupFileCloud(file){
    const reader = new FileReader();
    reader.onload = async ev => {
      try{
        const payload = JSON.parse(ev.target.result);
        if(!payload || !Array.isArray(payload.readings)){
          alert('Файл бекапу пошкоджений або має неправильний формат.');
          return;
        }
        const imported = payload.readings
          .map(([t,mgdl,dev])=>({t, mgdl, mmol: mgdlToMmol(mgdl), dev: normalizeDeviceId(dev)}))
          .filter(r=>Number.isFinite(r.t) && Number.isFinite(r.mgdl));
        if(imported.length===0){ alert('У файлі бекапу не знайдено жодного коректного виміру.'); return; }
        const ok = confirm(`Імпортувати бекап (${imported.length.toLocaleString('uk-UA')} записів) у хмару? Дані об'єднаються з поточною історією.`);
        if(!ok) return;
        FULL_HISTORY = mergeReadings(FULL_HISTORY, imported);
        CURRENT_DEVICE_FILTER = 'all';
        applyDeviceFilterAndRender();
        await sbSaveReadings(CURRENT_USER.id, imported);
        if(payload.deviceColors && typeof payload.deviceColors==='object'){
          for(const [dev, key] of Object.entries(payload.deviceColors)){
            DEVICE_COLORS[dev] = key;
            await sbSaveDeviceColor(CURRENT_USER.id, dev, key);
          }
          renderColorPicker(); renderSensorTabs();
        }
        alert('Бекап успішно відновлено та збережено в хмарі.');
      } catch(err){
        alert('Помилка читання файлу бекапу: ' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ---------- Doctor access management ---------- */
  async function loadDoctorsList(){
    const listEl = document.getElementById('doctorsList');
    try{
      const rows = await sbListMyDoctors(CURRENT_USER.id);
      if(rows.length === 0){
        listEl.innerHTML = '<p class="card-note">Ще жодного лікаря не запрошено.</p>';
        return;
      }
      listEl.innerHTML = rows.map(r => `
        <div class="doctor-list-item">
          <span>${(r.profiles && (r.profiles.full_name || r.profiles.email)) || 'Лікар'}</span>
          <button class="revoke-btn" data-id="${r.id}" type="button">Відкликати</button>
        </div>
      `).join('');
      listEl.querySelectorAll('.revoke-btn').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          if(!confirm('Скасувати доступ цього лікаря до твоїх даних?')) return;
          try{ await sbRevokeDoctor(btn.dataset.id); loadDoctorsList(); }
          catch(e){ alert('Помилка: ' + e.message); }
        });
      });
    }catch(e){
      listEl.innerHTML = '<p class="card-note">Не вдалося завантажити список.</p>';
    }
  }

  document.getElementById('inviteBtn').addEventListener('click', async ()=>{
    const emailEl = document.getElementById('inviteEmail');
    const errEl = document.getElementById('inviteError');
    errEl.classList.remove('show');
    const email = emailEl.value.trim();
    if(!email){ return; }
    try{
      await sbInviteDoctor(CURRENT_USER.id, email);
      emailEl.value = '';
      loadDoctorsList();
    }catch(e){
      errEl.textContent = e.message;
      errEl.classList.add('show');
    }
  });

  boot();
})();
