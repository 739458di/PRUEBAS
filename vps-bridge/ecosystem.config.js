module.exports = {
  apps: [{
    name: 'fyra-bridge',
    script: 'wa-bridge-v2.js',
    cwd: '/root/wa-bridge',
    node_args: '--max-old-space-size=512',
    max_memory_restart: '600M',
    env: {
      PORT: '3000',
      TURSO_URL: 'libsql://crm-fyradrive-739458di.aws-us-west-2.turso.io',
      TURSO_AUTH_TOKEN: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzA4MjUwMDYsImlkIjoiYTczOTliMjctYWFlNi00YjhmLWJmYjktODQ2M2JmMWU1MzljIiwicmlkIjoiNWVhMDBiM2QtNzNiNS00Njg3LWFjN2YtMTNhMGQzZmJlZmM1In0.ZVnn2UF2WdEw_yvQYGGB9Eyvbh_JRniPhkByn6Vxiavki0FkHVM8Xb0cwu1Ijrhti_j3iiOxS5jtt2IwCRWvDA',
      BRIDGE_API_KEY: 'fyra-bridge-v2-2026',
      SALESBRAIN_UPLOAD_URL: 'https://sales-brain-theta.vercel.app/api/upload',
      SALESBRAIN_KEY: 'fyradrive-sb-2026'
    }
  }]
};
