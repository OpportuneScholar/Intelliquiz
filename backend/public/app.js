const API_BASE=(window.INTELLIQUIZ_API||"").replace(/\/$/,"");
const $=s=>document.querySelector(s);
const forms={login:$("#loginForm"),register:$("#registerForm"),teacher:$("#teacherForm")};
let pendingTeacher=null;
$("#year").textContent=new Date().getFullYear();
function message(text,error=false){const el=$("#message");el.textContent=text;el.classList.remove("hidden","error");if(error)el.classList.add("error")}
function clearMessage(){$("#message").classList.add("hidden")}
function showView(view){clearMessage();Object.entries(forms).forEach(([k,f])=>f.classList.toggle("hidden",k!==view));document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.view===view));$("#teacherStepOne").classList.remove("hidden");$("#teacherStepTwo").classList.add("hidden")}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
async function api(path,options={}){const headers={"Content-Type":"application/json",...(options.headers||{})};const token=localStorage.getItem("iq_token");if(token)headers.Authorization="Bearer "+token;let response;try{response=await fetch(API_BASE+path,{...options,headers})}catch(e){throw new Error("Cannot reach the API. Check that the backend is deployed and set window.INTELLIQUIZ_API to its URL.")}const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||"Request failed ("+response.status+")");return data}
function showDashboard(data){
  $("#auth").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#welcome").textContent="Welcome, "+(data.user.name||"there");
  $("#roleText").textContent=(data.user.role==="teacher"?"Teacher workspace":"Student workspace")+" · Signed in securely";
  $("#accountName").textContent=data.user.name||"IntelliQuiz member";
  $("#accountEmail").textContent=data.user.email||"";
}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();clearMessage();const f=new FormData(e.currentTarget);try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:f.get("email"),password:f.get("password"),role:f.get("role")})});localStorage.setItem("iq_token",d.token);showDashboard(d)}catch(err){message(err.message,true)}});
$("#registerForm").addEventListener("submit",async e=>{e.preventDefault();clearMessage();const f=new FormData(e.currentTarget);const body=Object.fromEntries(f.entries());try{const d=await api("/api/auth/register",{method:"POST",body:JSON.stringify(body)});localStorage.setItem("iq_token",d.token);showDashboard(d)}catch(err){message(err.message,true)}});
$("#requestOtp").addEventListener("click",async()=>{clearMessage();const f=new FormData(forms.teacher);pendingTeacher={name:f.get("name"),email:f.get("email"),password:f.get("password")};if(!pendingTeacher.name||!pendingTeacher.email||pendingTeacher.password.length<10){message("Enter your name, valid email and a password of at least 10 characters.",true);return}try{const d=await api("/api/teacher-registration/request-otp",{method:"POST",body:JSON.stringify(pendingTeacher)});$("#teacherStepOne").classList.add("hidden");$("#teacherStepTwo").classList.remove("hidden");message(d.message||"Verification code sent. Check your inbox.")}catch(err){message(err.message,true)}});
$("#verifyOtp").addEventListener("click",async()=>{clearMessage();const otp=$("#otp").value.trim();if(!pendingTeacher||!/^\d{6}$/.test(otp)){message("Enter the 6-digit verification code.",true);return}try{await api("/api/teacher-registration/verify-otp",{method:"POST",body:JSON.stringify({email:pendingTeacher.email,otp})});message("Email verified. Your teacher account flow is complete; please sign in.") ;showView("login");$("#loginForm [name=email]").value=pendingTeacher.email;$("#loginForm [name=role]").value="teacher";pendingTeacher=null}catch(err){message(err.message,true)}});
$("#logout").addEventListener("click",()=>{localStorage.removeItem("iq_token");$("#dashboard").classList.add("hidden");$("#auth").classList.remove("hidden");showView("login")});
$("#refresh").addEventListener("click",()=>{const token=localStorage.getItem("iq_token");if(!token){$("#logout").click();return}api("/api/auth/me").then(d=>showDashboard(d)).catch(()=>{message("Session expired. Please sign in again.",true);$("#logout").click()})});
const token=localStorage.getItem("iq_token");if(token)api("/api/auth/me").then(showDashboard).catch(()=>localStorage.removeItem("iq_token"));
