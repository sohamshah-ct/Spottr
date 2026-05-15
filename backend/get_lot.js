const{Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
p.query("SELECT id,lat,lng,name FROM lots WHERE region='hartford_downtown' AND bbox_north IS NOT NULL LIMIT 1")
.then(r=>{console.log(JSON.stringify(r.rows[0]));p.end()}).catch(e=>{console.error(e.message);p.end()});
