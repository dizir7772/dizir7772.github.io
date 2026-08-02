(function(){
  let mode = 'login'; // 'login' | 'signup'
  let selectedRole = 'patient';

  const authTitle = document.getElementById('authTitle');
  const roleToggle = document.getElementById('roleToggle');
  const nameField = document.getElementById('nameField');
  const submitBtn = document.getElementById('submitBtn');
  const switchModeText = document.getElementById('switchModeText');
  const switchModeLink = document.getElementById('switchModeLink');
  const authError = document.getElementById('authError');
  const authSuccess = document.getElementById('authSuccess');
  const form = document.getElementById('authForm');

  function showError(msg){
    authError.textContent = msg;
    authError.classList.add('show');
    authSuccess.classList.remove('show');
  }
  function showSuccess(msg){
    authSuccess.textContent = msg;
    authSuccess.classList.add('show');
    authError.classList.remove('show');
  }
  function clearMessages(){
    authError.classList.remove('show');
    authSuccess.classList.remove('show');
  }

  function setMode(newMode){
    mode = newMode;
    clearMessages();
    if(mode === 'login'){
      authTitle.textContent = 'Вхід';
      roleToggle.style.display = 'none';
      nameField.style.display = 'none';
      submitBtn.textContent = 'Увійти';
      switchModeText.innerHTML = 'Ще немає акаунта? <a id="switchModeLink">Зареєструватись</a>';
    } else {
      authTitle.textContent = 'Реєстрація';
      roleToggle.style.display = 'flex';
      nameField.style.display = 'block';
      submitBtn.textContent = 'Зареєструватись';
      switchModeText.innerHTML = 'Вже є акаунт? <a id="switchModeLink">Увійти</a>';
    }
    document.getElementById('switchModeLink').addEventListener('click', ()=> setMode(mode==='login'?'signup':'login'));
  }

  document.getElementById('switchModeLink').addEventListener('click', ()=> setMode('signup'));

  roleToggle.querySelectorAll('.role-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      roleToggle.querySelectorAll('.role-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      selectedRole = btn.dataset.role;
    });
  });

  function redirectByRole(role){
    window.location.href = role === 'doctor' ? 'doctor.html' : 'patient.html';
  }

  async function checkExistingSession(){
    try{
      const session = await sbGetSession();
      if(session){
        const profile = await sbGetProfile(session.user.id);
        redirectByRole(profile.role);
      }
    }catch(e){ /* not logged in, stay on this page */ }
  }
  checkExistingSession();

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    clearMessages();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const fullName = document.getElementById('fullName').value.trim();

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try{
      if(mode === 'login'){
        const data = await sbSignIn(email, password);
        const profile = await sbGetProfile(data.user.id);
        redirectByRole(profile.role);
      } else {
        if(!fullName){ showError("Вкажіть ім'я."); submitBtn.disabled=false; submitBtn.textContent='Зареєструватись'; return; }
        const data = await sbSignUp(email, password, selectedRole, fullName);
        if(data.session){
          redirectByRole(selectedRole);
        } else {
          showSuccess('Реєстрація успішна! Перевірте пошту та перейдіть за посиланням підтвердження, потім увійдіть.');
          setMode('login');
        }
      }
    } catch(err){
      showError(err.message || 'Сталася помилка. Спробуйте ще раз.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode==='login' ? 'Увійти' : 'Зареєструватись';
    }
  });

  setMode('login');
})();
