import { google } from 'googleapis';
import readline from 'readline';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not found in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// We want scopes for calendar and workspace stuff
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.modify'
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent' // Forces consent screen to ensure refresh token is returned
});

console.log('--- AUTENTICAÇÃO DO GOOGLE WORKSPACE ---');
console.log('1. Clique no link abaixo e autorize com sua conta Google:');
console.log('\n', authUrl, '\n');
console.log('2. Copie o código de autorização que será gerado (authorization code).');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Cole o código aqui: ', async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    if (tokens.refresh_token) {
      console.log('\n✅ Autenticação bem-sucedida! Refresh Token recebido.');
      
      const envPath = path.join(process.cwd(), '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }
      
      // Update or append GOOGLE_REFRESH_TOKEN
      if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
        envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        envContent += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      }
      
      fs.writeFileSync(envPath, envContent);
      console.log('📝 GOOGLE_REFRESH_TOKEN foi salvo no seu arquivo .env com sucesso!');
      console.log('Agora você pode reiniciar o seu bot (npm run dev) e a agenda funcionará!');
    } else {
      console.log('\n❌ Erro: O Google não retornou um Refresh Token. Certifique-se de que você aceitou todas as permissões e que não autenticou recentemente sem revogar o acesso antes.');
    }
  } catch (error) {
    console.error('Erro ao resgatar tokens:', error.message);
  } finally {
    rl.close();
  }
});
