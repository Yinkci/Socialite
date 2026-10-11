const $=s=>document.querySelector(s);
let setup=false;

const status=await fetch('/api/auth-status').then(r=>r.json()).catch(()=>({}));
if(status.signedIn) location.replace('/');
setup=!!status.setup;
if(setup) {
  $('#login-title').textContent='Create your password';
  $('#login-intro').textContent='First sign-in. Enter the setup code, then choose a password of at least 10 characters.';
  $('#setup-label').hidden=$('#confirm-label').hidden=false;
  $('#password').autocomplete='new-password';
  $('.login-submit').textContent='Create password and sign in';
}

$('#login-form').onsubmit=async event=>{
  event.preventDefault();
  const error=$('#login-error'), button=$('.login-submit');
  error.hidden=true;
  if(setup&&$('#password').value!==$('#confirm').value){error.textContent='The passwords do not match.';error.hidden=false;return;}
  button.disabled=true;
  try {
    const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#password').value,setupCode:$('#setup-code').value.trim()})});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error||'Sign-in failed.');
    location.replace('/');
  } catch(e) {error.textContent=e.message;error.hidden=false;}
  finally {button.disabled=false;}
};
