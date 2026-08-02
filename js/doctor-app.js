(function(){
  let CURRENT_USER = null;
  let CURRENT_PROFILE = null;
  let patientsCache = [];

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
    if(CURRENT_PROFILE.role !== 'doctor'){
      window.location.href = 'patient.html';
      return;
    }

    document.getElementById('doctorNameTitle').textContent = CURRENT_PROFILE.full_name || CURRENT_PROFILE.email;

    CAN_EDIT = false; // лікар лише переглядає
    initCollapsibleCards();

    await loadPatientList();
  }

  document.getElementById('logoutBtn').addEventListener('click', async ()=>{
    await sbSignOut();
    window.location.href = 'index.html';
  });

  async function loadPatientList(){
    const container = document.getElementById('patientListContainer');
    try{
      const rows = await sbListMyPatients(CURRENT_USER.id);
      patientsCache = rows;
      if(rows.length === 0){
        container.innerHTML = `<div class="empty-state">
          <p style="font-size:16px;color:var(--ink);margin-bottom:8px;">Ще немає жодного пацієнта</p>
          <p>Пацієнт має надати тобі доступ зі свого кабінету (розділ "Мої лікарі"), вказавши твій email: <b class="mono">${CURRENT_PROFILE.email}</b></p>
        </div>`;
        return;
      }
      container.innerHTML = `<div class="patient-list">${rows.map(r=>`
        <div class="patient-card" data-patient-id="${r.patient_id}">
          <p class="patient-card-name">${(r.profiles && (r.profiles.full_name || r.profiles.email)) || 'Пацієнт'}</p>
          <p class="patient-card-meta">${r.profiles ? r.profiles.email : ''}</p>
        </div>
      `).join('')}</div>`;
      container.querySelectorAll('.patient-card').forEach(card=>{
        card.addEventListener('click', ()=>openPatient(card.dataset.patientId));
      });
    }catch(e){
      container.innerHTML = '<p class="card-note">Не вдалося завантажити список пацієнтів.</p>';
    }
  }

  async function openPatient(patientId){
    document.getElementById('patientListView').style.display = 'none';
    const dashView = document.getElementById('dashboardView');
    dashView.style.display = 'block';
    document.getElementById('patientNameTitle').textContent = 'Завантаження…';

    try{
      const [readings, colors] = await Promise.all([
        sbLoadReadings(patientId),
        sbLoadDeviceColors(patientId)
      ]);
      DEVICE_COLORS = colors;
      FULL_HISTORY = readings;

      const meta = patientsCache.find(p=>p.patient_id===patientId);
      document.getElementById('patientNameTitle').textContent =
        (meta && meta.profiles && (meta.profiles.full_name || meta.profiles.email)) || 'Пацієнт';

      if(FULL_HISTORY.length === 0){
        document.getElementById('heroSection').insertAdjacentHTML('beforebegin',
          '<div class="empty-state card"><p style="font-size:16px;color:var(--ink);">У цього пацієнта ще немає жодного виміру.</p></div>');
      }

      applyDeviceFilterAndRender();
    }catch(e){
      alert('Не вдалося завантажити дані пацієнта: ' + e.message);
      backToList();
    }
  }

  function backToList(){
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('patientListView').style.display = 'block';
    document.querySelectorAll('.empty-state.card').forEach(el=>el.remove());
  }
  document.getElementById('backToListBtn').addEventListener('click', backToList);

  boot();
})();
