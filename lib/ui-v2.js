// lib/ui-v2.js — общ нов вид (05.11, дизайн система Motamo) за работните страници, които имат свой CSS.
// Само допълва (след страничния CSS): шрифтове, топло платно, червено от логото, меки форми. Не сменя логиката и подредбата.
module.exports = {
  fonts: '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@600;700;800&display=swap" rel="stylesheet">',
  css: `
/* ★ нов вид 05.11 */
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif!important;background:#F5F2EC!important;color:#141414;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:Montserrat,system-ui,sans-serif!important;letter-spacing:-.005em}
header{background:#181615!important;background-image:none!important;box-shadow:none!important}
button,input,select,textarea{font-family:Inter,system-ui,sans-serif}
button{border-radius:999px!important;font-weight:700!important;box-shadow:none!important}
button.prod{background:#2E7D32!important;background-image:none!important}
button.acc,button.primary{background:#E30613!important;background-image:none!important}
button.alt{border:1px solid #D9D4C8!important}
input,select,textarea{border-radius:12px!important}
#grid th,.pickhd{background:#181615!important}
.msg{border-radius:14px!important}
.scroll,.card,.pickbox,.box,.panel{border-radius:20px!important}
a{color:inherit}
`
};
