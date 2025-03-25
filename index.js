const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// Configuración de la API de YouTube
const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY
});

// Función para crear archivo temporal de cookies
function createTempCookieFile(cookies) {
    const tempDir = os.tmpdir();
    const cookieFile = path.join(tempDir, 'youtube_cookies.txt');
    fs.writeFileSync(cookieFile, cookies);
    return cookieFile;
}

// Opciones globales para youtube-dl
const ytdlOptions = {
    format: 'bestaudio/best',
    noWarnings: true,
    noCallHome: true,
    preferFreeFormats: true,
    youtubeSkipDashManifest: true,
    referer: 'https://www.youtube.com',
    geoBypass: true,
    geoBypassCountry: 'US',
    addHeader: [
        'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language:en-US,en;q=0.5',
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ],
    socketTimeout: '10',
    extractorRetries: 'infinite',
    forceIpv4: true,
    noCheckCertificates: true
};

// Si hay cookies en las variables de entorno, crear archivo temporal
if (process.env.YOUTUBE_COOKIES) {
    const cookieFile = createTempCookieFile(process.env.YOUTUBE_COOKIES);
    ytdlOptions.cookies = cookieFile;
}

// Cola de reproducción global (por servidor)
const queues = new Map();

// Ruta al archivo de playlists
const playlistsPath = path.join(__dirname, 'playlists.json');

// Función para cargar las playlists
function loadPlaylists() {
    try {
        if (fs.existsSync(playlistsPath)) {
            const data = fs.readFileSync(playlistsPath, 'utf8');
            return JSON.parse(data);
        }
        return {};
    } catch (error) {
        console.error('[DEBUG] Error al cargar playlists:', error);
        return {};
    }
}

// Función para guardar las playlists
function savePlaylists(playlists) {
    try {
        fs.writeFileSync(playlistsPath, JSON.stringify(playlists, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('[DEBUG] Error al guardar playlists:', error);
        return false;
    }
}

// Inicializar playlists
let playlists = loadPlaylists();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

const prefix = '!';

// Remover todos los listeners existentes al inicio del archivo
client.removeAllListeners();

// Map para rastrear búsquedas activas
const activeSearches = new Map();

// Función para obtener información detallada de un video usando la API de YouTube
async function getVideoDetails(videoId) {
    try {
        const response = await youtube.videos.list({
            part: ['snippet', 'contentDetails', 'statistics'],
            id: videoId
        });

        if (!response.data.items || response.data.items.length === 0) {
            return null;
        }

        const video = response.data.items[0];
        return {
            title: video.snippet.title,
            url: `https://www.youtube.com/watch?v=${video.id}`,
            duration: convertYouTubeDuration(video.contentDetails.duration),
            thumbnail: video.snippet.thumbnails.high.url,
            channel: video.snippet.channelTitle,
            views: video.statistics.viewCount,
            likes: video.statistics.likeCount,
            publishedAt: video.snippet.publishedAt
        };
    } catch (error) {
        console.error('[DEBUG] Error al obtener detalles del video:', error);
        return null;
    }
}

// Función para extraer el ID de video de una URL de YouTube
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// Función de búsqueda usando la API de YouTube
async function searchYoutube(query) {
    try {
        const response = await youtube.search.list({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: 3
        });

        if (!response.data.items || response.data.items.length === 0) {
            return null;
        }

        return response.data.items.map(item => ({
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            thumbnail: item.snippet.thumbnails.default.url,
            channel: item.snippet.channelTitle
        }));
    } catch (error) {
        console.error('[DEBUG] Error en búsqueda de YouTube API:', error);
        return null;
    }
}

// Función para reproducir la siguiente canción en la cola
async function playNext(guildId, message) {
    console.log(`[DEBUG] Intentando reproducir la siguiente canción para ${guildId}`);
    
    const serverQueue = queues.get(guildId);
    if (!serverQueue) {
        console.log(`[DEBUG] No hay cola para ${guildId}`);
        return;
    }
    
    if (serverQueue.songs.length === 0) {
        console.log(`[DEBUG] Cola vacía para ${guildId}, desconectando`);
        if (serverQueue.connection) {
            serverQueue.connection.destroy();
        }
        queues.delete(guildId);
        return;
    }
    
    const currentSong = serverQueue.songs[0];
    console.log(`[DEBUG] Reproduciendo: ${currentSong.title}`);
    
    try {
        console.log('[DEBUG] Obteniendo URL del stream');
        const output = await youtubedl(currentSong.url, {
            ...ytdlOptions,
            dumpSingleJson: true,
            format: 'bestaudio/best',
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0'
        });

        if (!output || !output.url) {
            throw new Error('No se pudo obtener la URL del stream');
        }

        console.log('[DEBUG] URL del stream obtenida correctamente');

        // Crear proceso FFmpeg
        const ffmpeg = spawn('ffmpeg', [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '30',
            '-i', output.url,
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-acodec', 'pcm_s16le',
            '-loglevel', 'warning',
            '-vn',
            'pipe:1'
        ]);

        // Crear recurso de audio
        const resource = createAudioResource(ffmpeg.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });
        
        resource.volume.setVolume(serverQueue.volume / 10);
        
        serverQueue.currentResource = resource;
        serverQueue.currentStartTime = Date.now();
        
        if (!serverQueue.player) {
            console.log('[DEBUG] Creando nuevo reproductor de audio');
            serverQueue.player = createAudioPlayer();
            
            serverQueue.player.on(AudioPlayerStatus.Idle, () => {
                console.log('[DEBUG] Reproductor inactivo');
                
                if (serverQueue.repeat) {
                    console.log('[DEBUG] Repetición activada, reproduciendo la misma canción');
                    playNext(guildId, message);
                    return;
                }
                
                if (serverQueue.loop && serverQueue.songs.length > 0) {
                    console.log('[DEBUG] Bucle activado, moviendo canción actual al final de la cola');
                    const finishedSong = serverQueue.songs.shift();
                    serverQueue.songs.push(finishedSong);
                } else {
                    console.log('[DEBUG] Pasando a la siguiente canción');
                    serverQueue.songs.shift();
                }
                
                setTimeout(() => {
                    playNext(guildId, message);
                }, 500);
            });
            
            serverQueue.player.on('error', error => {
                console.error('[DEBUG] Error en el reproductor:', error);
                message.channel.send('❌ Error durante la reproducción, pasando a la siguiente canción.');
                
                serverQueue.songs.shift();
                playNext(guildId, message);
            });
            
            serverQueue.connection.subscribe(serverQueue.player);
        }
        
        serverQueue.player.play(resource);
        
        // Verificar reproducción
        let playbackStarted = false;
        const playbackCheck = setTimeout(() => {
            if (!playbackStarted && serverQueue.player.state.status !== AudioPlayerStatus.Playing) {
                console.error('[DEBUG] La reproducción no se inició correctamente después de 5 segundos');
                message.channel.send('❌ Error al iniciar la reproducción. Intentando con la siguiente canción...');
                
                serverQueue.songs.shift();
                playNext(guildId, message);
            }
        }, 5000);
        
        serverQueue.player.once(AudioPlayerStatus.Playing, () => {
            playbackStarted = true;
            clearTimeout(playbackCheck);
            console.log('[DEBUG] Reproducción iniciada correctamente');
            
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('▶️ Reproduciendo ahora')
                .setDescription(`[${currentSong.title}](${currentSong.url})`);
                
            if (currentSong.thumbnail) {
                embed.setThumbnail(currentSong.thumbnail);
            }
            
            if (currentSong.duration && currentSong.channel) {
                embed.addFields({ 
                    name: 'Info', 
                    value: `⏱️ ${formatTime(currentSong.duration)} | 📺 ${currentSong.channel}` 
                });
            }
            
            embed.setFooter({ text: `Solicitado por ${currentSong.requestedBy}` });
            
            message.channel.send({ embeds: [embed] });
        });
        
    } catch (error) {
        console.error('[DEBUG] Error al reproducir:', error);
        message.channel.send('❌ Error al reproducir esta canción.');
        
        // Limpiar archivo de cookies temporal si existe
        if (ytdlOptions.cookies && fs.existsSync(ytdlOptions.cookies)) {
            try {
                fs.unlinkSync(ytdlOptions.cookies);
            } catch (err) {
                console.error('[DEBUG] Error al eliminar archivo de cookies temporal:', err);
            }
        }
        
        serverQueue.songs.shift();
        playNext(guildId, message);
    }
}

// Función para formatear tiempo (segundos -> MM:SS)
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Función para generar una barra de progreso visual
function createProgressBar(current, total, length = 15) {
    const percentage = current / total;
    const progress = Math.round(length * percentage);
    const emptyProgress = length - progress;
    
    const progressText = '▇'.repeat(progress);
    const emptyProgressText = '—'.repeat(emptyProgress);
    const percentageText = Math.round(percentage * 100) + '%';
    
    return `[${progressText}${emptyProgressText}] ${percentageText}`;
}

// Modificar la función processYoutubeUrl para usar primero la API de Google
async function processYoutubeUrl(url, message, voiceChannel, statusMessage) {
    const guildId = message.guild.id;
    let serverQueue = queues.get(guildId);
    
    try {
        console.log('[DEBUG] Obteniendo info del video');
        
        // Obtener información usando la API de YouTube
        const videoId = extractVideoId(url);
        if (!videoId) {
            throw new Error('URL de YouTube inválida');
        }

        const videoDetails = await getVideoDetails(videoId);
        if (!videoDetails) {
            throw new Error('No se pudo obtener información del video');
        }

        const songInfo = {
            title: videoDetails.title,
            url: url,
            duration: videoDetails.duration,
            thumbnail: videoDetails.thumbnail,
            requestedBy: message.author.username,
            channel: videoDetails.channel
        };

        console.log('[DEBUG] Información obtenida desde API de Google');

        // Verificar si la canción ya existe en la cola
        if (serverQueue) {
            const songExists = serverQueue.songs.some(song => song.url === url);
            if (songExists) {
                await statusMessage.edit(`❌ **${songInfo.title}** ya está en la cola. No se puede agregar dos veces la misma canción.`);
                return;
            }
        }
        
        // Si no existe una cola para este servidor, créala
        if (!serverQueue) {
            const queueConstruct = {
                textChannel: message.channel,
                voiceChannel: voiceChannel,
                connection: null,
                player: null,
                songs: [],
                volume: 5,
                playing: true,
                loop: false,
                repeat: false,
                currentResource: null,
                currentStartTime: null,
                audioUrl: null,
                processing: false
            };
            
            queueConstruct.songs.push(songInfo);
            queues.set(guildId, queueConstruct);
            
            console.log(`[DEBUG] Cola creada para ${guildId}`);
            
            try {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });
                
                let readyLock = false;
                connection.on(VoiceConnectionStatus.Ready, () => {
                    if (readyLock) return;
                    readyLock = true;
                    console.log('[DEBUG] Conexión lista');
                });
                
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    console.log('[DEBUG] Desconectado del canal de voz');
                    try {
                        if (queueConstruct.currentFfmpeg) {
                            queueConstruct.currentFfmpeg.kill();
                        }
                        queues.delete(guildId);
                        readyLock = false;
                    } catch (err) {
                        console.error('[DEBUG] Error al limpiar la cola:', err);
                    }
                });
                
                queueConstruct.connection = connection;
                
                await statusMessage.edit(`✅ **${songInfo.title}** ha sido añadida a la cola.`);
                await playNext(guildId, message);
                
            } catch (err) {
                console.error('[DEBUG] Error al conectar:', err);
                queues.delete(guildId);
                await statusMessage.edit('❌ Error al conectar al canal de voz.');
                return;
            }
        } else {
            if (serverQueue.processing) {
                console.log('[DEBUG] Ya se está procesando una solicitud para esta cola');
                return;
            }
            
            serverQueue.processing = true;
            serverQueue.songs.push(songInfo);
            
            console.log(`[DEBUG] Canción añadida a la cola existente: ${songInfo.title}`);
            
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('🎵 Añadida a la cola')
                .setDescription(`[${songInfo.title}](${songInfo.url})`)
                .setFooter({ text: `Solicitado por ${message.author.username}` });
                
            if (songInfo.thumbnail) {
                embed.setThumbnail(songInfo.thumbnail);
            }
            
            if (songInfo.duration) {
                embed.addFields({ 
                    name: 'Info', 
                    value: `⏱️ ${formatTime(songInfo.duration)} | 📺 ${songInfo.channel}` 
                });
            }
            
            await statusMessage.edit({ content: null, embeds: [embed] });
            serverQueue.processing = false;
        }
        
    } catch (error) {
        console.error('[DEBUG] Error al obtener info del video:', error);
        await statusMessage.edit('❌ Error al obtener información del video.');
        if (serverQueue) {
            serverQueue.processing = false;
        }
    }
}

// Función auxiliar para convertir duración de ISO 8601 a segundos
function convertDuration(duration) {
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    const hours = (parseInt(match[1]) || 0);
    const minutes = (parseInt(match[2]) || 0);
    const seconds = (parseInt(match[3]) || 0);
    return hours * 3600 + minutes * 60 + seconds;
}

// Registrar el evento ready una sola vez
client.once('ready', () => {
    console.log(`[DEBUG] Bot listo como ${client.user.tag}`);
});

// Registrar el evento messageCreate una sola vez
client.on('messageCreate', async (message) => {
    // Evitar procesamiento duplicado
    if (message._handled) return;
    message._handled = true;

    if (!message.content.startsWith(prefix) || message.author.bot) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    console.log(`[DEBUG] Comando recibido: ${command}`);
    
    // Obtener la cola del servidor
    const guildId = message.guild.id;
    let serverQueue = queues.get(guildId);
    
    switch (command) {
        case 'play':
            const voiceChannel = message.member.voice.channel;
            if (!voiceChannel) {
                return message.reply('¡Necesitas unirte a un canal de voz primero!');
            }
            
            const input = args.join(' ');
            if (!input) {
                return message.reply('¡Necesitas proporcionar una URL o término de búsqueda!');
            }
            
            console.log(`[DEBUG] Input recibido: ${input}`);
            
            // Mensaje de estado inicial
            const statusMessage = await message.reply('🔄 Procesando...');
            
            try {
                // Verificar si el input es una URL o un término de búsqueda
                const isUrl = input.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/);
                
                if (isUrl) {
                    // Es una URL, proceder directamente
                    console.log(`[DEBUG] URL detectada: ${input}`);
                    await processYoutubeUrl(input, message, voiceChannel, statusMessage);
                } else {
                    // Es un término de búsqueda
                    console.log(`[DEBUG] Término de búsqueda detectado: ${input}`);
                    await statusMessage.edit('🔍 Buscando videos en YouTube...');
                    
                    const searchResults = await searchYoutube(input);
                    
                    if (!searchResults) {
                        return statusMessage.edit('❌ No se encontraron resultados para tu búsqueda.');
                    }
                    
                    // Formatear resultados
                    const resultsEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('🔍 Resultados de búsqueda')
                        .setDescription('Escribe el número (1-3) del video que quieres reproducir, o X para cancelar')
                        .addFields(
                            searchResults.map((video, index) => ({
                                name: `${index + 1}. ${video.title}`,
                                value: `Canal: ${video.channel}`
                            }))
                        )
                        .setFooter({ text: 'Esta selección expirará en 30 segundos' });
                    
                    await statusMessage.edit({ content: null, embeds: [resultsEmbed] });
                    
                    // Esperar selección del usuario
                    const filter = m => (m.author.id === message.author.id) && 
                                      (m.content === '1' || m.content === '2' || m.content === '3' || m.content.toLowerCase() === 'x');
                    
                    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
                    const selectedMsg = collected.first();
                    
                    if (selectedMsg) {
                        try {
                            await selectedMsg.delete();
                        } catch (err) {
                            console.log('[DEBUG] No se pudo eliminar el mensaje de selección');
                        }
                        
                        if (selectedMsg.content.toLowerCase() === 'x') {
                            return statusMessage.edit('🛑 Búsqueda cancelada.');
                        }
                        
                        const selectedIndex = parseInt(selectedMsg.content) - 1;
                        const selectedVideo = searchResults[selectedIndex];
                        
                        if (!selectedVideo) {
                            return statusMessage.edit('❌ Selección inválida.');
                        }
                        
                        statusMessage.edit('🔄 Procesando video seleccionado...');
                        await processYoutubeUrl(selectedVideo.url, message, voiceChannel, statusMessage);
                    } else {
                        return statusMessage.edit('⌛ Tiempo de selección expirado.');
                    }
                }
            } catch (error) {
                console.error('[DEBUG] Error al procesar input:', error);
                statusMessage.edit('❌ Error al procesar. Verifica la URL o intenta con otro término de búsqueda.');
            }
            break;
            
        case 'skip':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción para saltar!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            message.reply('⏭️ Saltando canción actual...');
            if (serverQueue.player) {
                serverQueue.player.stop(); // Esto desencadenará el evento Idle y pasará a la siguiente canción
            }
            break;
            
        case 'stop':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción para detener!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            serverQueue.songs = [];
            if (serverQueue.player) {
                serverQueue.player.stop();
            }
            
            if (serverQueue.connection) {
                serverQueue.connection.destroy();
            }
            
            queues.delete(guildId);
            message.reply('⏹️ Reproducción detenida y cola limpiada.');
            break;
            
        case 'pause':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción para pausar!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            if (serverQueue.player.state.status === AudioPlayerStatus.Playing) {
                serverQueue.player.pause();
                message.reply('⏸️ Reproducción pausada.');
            } else {
                message.reply('¡La reproducción ya está pausada!');
            }
            break;
            
        case 'resume':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción para reanudar!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            if (serverQueue.player.state.status === AudioPlayerStatus.Paused) {
                serverQueue.player.unpause();
                message.reply('▶️ Reproducción reanudada.');
            } else {
                message.reply('¡La reproducción no está pausada!');
            }
            break;
            
        case 'volume':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción para ajustar el volumen!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            const volume = parseInt(args[0]);
            if (isNaN(volume) || volume < 0 || volume > 10) {
                return message.reply('¡Por favor, proporciona un número del 0 al 10!');
            }
            
            serverQueue.volume = volume;
            if (serverQueue.currentResource) {
                serverQueue.currentResource.volume.setVolume(volume / 10);
            }
            
            message.reply(`🔊 Volumen ajustado a ${volume}/10.`);
            break;
            
        case 'nowplaying':
        case 'np':
            if (!serverQueue || !serverQueue.songs[0]) {
                return message.reply('¡No hay nada en reproducción!');
            }
            
            const currentSongInfo = serverQueue.songs[0];
            let currentTime = 0;
            let totalTime = currentSongInfo.duration || 0;
            
            if (serverQueue.currentStartTime) {
                const elapsed = (Date.now() - serverQueue.currentStartTime) / 1000;
                currentTime = Math.min(elapsed, totalTime);
            }
            
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('🎵 Reproduciendo ahora')
                .setDescription(`[${currentSongInfo.title}](${currentSongInfo.url})`);
                
            if (currentSongInfo.thumbnail) {
                embed.setThumbnail(currentSongInfo.thumbnail);
            }
            
            // Añadir barra de progreso si conocemos la duración
            if (totalTime > 0) {
                const progressBar = createProgressBar(currentTime, totalTime);
                embed.addFields({ 
                    name: 'Progreso', 
                    value: `${formatTime(currentTime)} ${progressBar} ${formatTime(totalTime)}` 
                });
            }
            
            embed.addFields(
                { name: 'Solicitado por', value: currentSongInfo.requestedBy }
            );
            
            message.channel.send({ embeds: [embed] });
            break;
            
        case 'queue':
            if (!serverQueue || serverQueue.songs.length === 0) {
                return message.reply('¡No tengo nada en la cola!');
            }
            
            const currentSong = serverQueue.songs[0];
            let queueList = `**Cola de Reproducción:**\n\n🎵 **Reproduciendo ahora:**\n[${currentSong.title}](${currentSong.url}) | Solicitado por: ${currentSong.requestedBy}\n\n`;
            
            if (serverQueue.songs.length > 1) {
                queueList += '**Siguientes canciones:**\n';
                for (let i = 1; i < serverQueue.songs.length; i++) {
                    const song = serverQueue.songs[i];
                    queueList += `${i}. [${song.title}](${song.url}) | Solicitado por: ${song.requestedBy}\n`;
                    
                    // Si la lista es demasiado larga, cortar
                    if (i === 10 && serverQueue.songs.length > 11) {
                        queueList += `\n*...y ${serverQueue.songs.length - 11} canciones más*`;
                        break;
                    }
                }
            }
            
            const queueEmbed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('🎵 Cola de Reproducción')
                .setDescription(queueList);
                
            message.channel.send({ embeds: [queueEmbed] });
            break;
            
        case 'loop':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            serverQueue.loop = !serverQueue.loop;
            message.reply(`🔄 Modo bucle de cola: ${serverQueue.loop ? 'Activado' : 'Desactivado'}`);
            break;
            
        case 'repeat':
            if (!serverQueue) {
                return message.reply('¡No hay nada en reproducción!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            serverQueue.repeat = !serverQueue.repeat;
            message.reply(`🔂 Repetición de canción actual: ${serverQueue.repeat ? 'Activada' : 'Desactivada'}`);
            break;
            
        case 'remove':
            if (!serverQueue) {
                return message.reply('¡No hay cola de reproducción!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            const index = parseInt(args[0]);
            if (isNaN(index) || index < 1 || index >= serverQueue.songs.length) {
                return message.reply(`¡Por favor, proporciona un índice válido entre 1 y ${serverQueue.songs.length - 1}!`);
            }
            
            const removedSong = serverQueue.songs.splice(index, 1)[0];
            message.reply(`🗑️ Eliminada: **${removedSong.title}**`);
            break;
            
        case 'clear':
            if (!serverQueue) {
                return message.reply('¡No hay cola de reproducción!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            // Mantener solo la canción actual
            const currentlyPlaying = serverQueue.songs[0];
            serverQueue.songs = [currentlyPlaying];
            
            message.reply('🧹 Cola limpita. Solo se conserva la canción actual.');
            break;
            
        case 'shuffle':
            if (!serverQueue || serverQueue.songs.length <= 1) {
                return message.reply('¡No hay suficientes canciones en la cola para mezclar!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            // Mezclar todas las canciones excepto la actual
            const current = serverQueue.songs[0];
            let queue = serverQueue.songs.slice(1);
            
            // Algoritmo de Fisher-Yates para mezclar
            for (let i = queue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [queue[i], queue[j]] = [queue[j], queue[i]];
            }
            
            // Reconstruir la cola
            serverQueue.songs = [current, ...queue];
            
            message.reply('🔀 Cola sucia.');
            break;
            
        case 'forward':
            if (!serverQueue || !serverQueue.songs[0]) {
                return message.reply('¡No hay nada en reproducción!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            // Por defecto, avanzar 10 segundos
            const seconds = args[0] ? parseInt(args[0]) : 10;
            
            if (isNaN(seconds) || seconds <= 0) {
                return message.reply('¡Por favor, proporciona un número válido de segundos para avanzar!');
            }
            
            const currentSongForward = serverQueue.songs[0];
            
            // Reiniciar la reproducción con la posición avanzada
            if (serverQueue.audioUrl && serverQueue.currentFfmpeg) {
                // Detener el proceso actual de FFmpeg
                serverQueue.currentFfmpeg.kill();
                
                // Calcular tiempo actual
                const elapsed = (Date.now() - serverQueue.currentStartTime) / 1000;
                const newPosition = elapsed + seconds;
                
                // Crear nuevo proceso FFmpeg con la nueva posición
                const ffmpeg = spawn('ffmpeg', [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-ss', newPosition.toString(),
                    '-i', serverQueue.audioUrl,
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-loglevel', 'warning',
                    'pipe:1'
                ]);
                
                // Crear nuevo recurso
                const resource = createAudioResource(ffmpeg.stdout, {
                    inputType: StreamType.Raw,
                    inlineVolume: true
                });
                
                // Configurar volumen
                resource.volume.setVolume(serverQueue.volume / 10);
                
                // Actualizar información
                serverQueue.currentResource = resource;
                serverQueue.currentFfmpeg = ffmpeg;
                serverQueue.currentStartTime = Date.now() - (newPosition * 1000);
                
                // Reproducir
                serverQueue.player.play(resource);
                
                message.reply(`⏩ Avanzado ${seconds} segundos.`);
            } else {
                message.reply('❌ No se puede avanzar en esta canción.');
            }
            break;
            
        case 'rewind':
            if (!serverQueue || !serverQueue.songs[0]) {
                return message.reply('¡No hay nada en reproducción!');
            }
            
            if (!message.member.voice.channel) {
                return message.reply('¡Debes estar en un canal de voz para usar este comando!');
            }
            
            // Por defecto, retroceder 10 segundos
            const rewindSeconds = args[0] ? parseInt(args[0]) : 10;
            
            if (isNaN(rewindSeconds) || rewindSeconds <= 0) {
                return message.reply('¡Por favor, proporciona un número válido de segundos para retroceder!');
            }
            
            // Reiniciar la reproducción con la posición retrocedida
            if (serverQueue.audioUrl && serverQueue.currentFfmpeg) {
                // Detener el proceso actual de FFmpeg
                serverQueue.currentFfmpeg.kill();
                
                // Calcular tiempo actual
                const elapsed = (Date.now() - serverQueue.currentStartTime) / 1000;
                const newPosition = Math.max(0, elapsed - rewindSeconds);
                
                // Crear nuevo proceso FFmpeg con la nueva posición
                const ffmpeg = spawn('ffmpeg', [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-ss', newPosition.toString(),
                    '-i', serverQueue.audioUrl,
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-loglevel', 'warning',
                    'pipe:1'
                ]);
                
                // Crear nuevo recurso
                const resource = createAudioResource(ffmpeg.stdout, {
                    inputType: StreamType.Raw,
                    inlineVolume: true
                });
                
                // Configurar volumen
                resource.volume.setVolume(serverQueue.volume / 10);
                
                // Actualizar información
                serverQueue.currentResource = resource;
                serverQueue.currentFfmpeg = ffmpeg;
                serverQueue.currentStartTime = Date.now() - (newPosition * 1000);
                
                // Reproducir
                serverQueue.player.play(resource);
                
                message.reply(`⏪ Retrocedido ${rewindSeconds} segundos.`);
            } else {
                message.reply('❌ No se puede retroceder en esta canción.');
            }
            break;
            
        case 'playlist':
        case 'pl':
            if (!args.length) {
                return message.reply('Por favor, especifica una acción: create, add, remove, list, play.');
            }
            
            const playlistAction = args.shift().toLowerCase();
            
            switch (playlistAction) {
                case 'create':
                    // Crear una nueva playlist
                    if (!args.length) {
                        return message.reply('Por favor, proporciona un nombre para la playlist.');
                    }
                    
                    const playlistName = args.join(' ').toLowerCase();
                    
                    if (playlists[playlistName]) {
                        return message.reply(`❌ Ya existe una playlist llamada "${playlistName}".`);
                    }
                    
                    playlists[playlistName] = {
                        creator: message.author.username,
                        songs: []
                    };
                    
                    if (savePlaylists(playlists)) {
                        message.reply(`✅ Playlist "${playlistName}" creada correctamente.`);
                    } else {
                        message.reply('❌ Error al guardar la playlist. Inténtalo de nuevo.');
                    }
                    break;
                    
                case 'add':
                    // Añadir canción a una playlist
                    if (args.length < 2) {
                        return message.reply('Uso: !playlist add [nombre_playlist] [URL o búsqueda]');
                    }
                    
                    const addToPlaylist = args.shift().toLowerCase();
                    
                    if (!playlists[addToPlaylist]) {
                        return message.reply(`❌ No existe una playlist llamada "${addToPlaylist}".`);
                    }
                    
                    const songToAdd = args.join(' ');
                    const isUrl = songToAdd.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/);
                    
                    const statusMessage = await message.reply('🔄 Procesando canción para añadir a la playlist...');
                    
                    try {
                        if (isUrl) {
                            // Es una URL directa
                            const videoInfo = await play.video_info(songToAdd);
                            
                            playlists[addToPlaylist].songs.push({
                                url: videoInfo.url,
                                title: videoInfo.title || 'Canción desconocida'
                            });
                            
                            if (savePlaylists(playlists)) {
                                statusMessage.edit(`✅ Añadida "${videoInfo.title}" a la playlist "${addToPlaylist}".`);
                            } else {
                                statusMessage.edit('❌ Error al guardar la playlist. Inténtalo de nuevo.');
                            }
                        } else {
                            // Es una búsqueda
                            const searchResults = await searchYoutube(songToAdd);
                            
                            if (!searchResults || searchResults.length === 0) {
                                return statusMessage.edit('❌ No se encontraron resultados para tu búsqueda.');
                            }
                            
                            const video = searchResults[0];
                            
                            playlists[addToPlaylist].songs.push({
                                url: video.url,
                                title: video.title
                            });
                            
                            if (savePlaylists(playlists)) {
                                statusMessage.edit(`✅ Añadida "${video.title}" a la playlist "${addToPlaylist}".`);
                            } else {
                                statusMessage.edit('❌ Error al guardar la playlist. Inténtalo de nuevo.');
                            }
                        }
                    } catch (error) {
                        console.error('[DEBUG] Error al añadir a playlist:', error);
                        statusMessage.edit('❌ Error al procesar la canción. Verifica la URL o intenta con otra búsqueda.');
                    }
                    break;
                    
                case 'remove':
                    // Eliminar canción de una playlist
                    if (args.length < 2) {
                        return message.reply('Uso: !playlist remove [nombre_playlist] [número_de_canción]');
                    }
                    
                    const removeFromPlaylist = args.shift().toLowerCase();
                    
                    if (!playlists[removeFromPlaylist]) {
                        return message.reply(`❌ No existe una playlist llamada "${removeFromPlaylist}".`);
                    }
                    
                    const songIndex = parseInt(args[0]) - 1;
                    
                    if (isNaN(songIndex) || songIndex < 0 || songIndex >= playlists[removeFromPlaylist].songs.length) {
                        return message.reply(`❌ Número de canción inválido. La playlist tiene ${playlists[removeFromPlaylist].songs.length} canciones.`);
                    }
                    
                    const removedSong = playlists[removeFromPlaylist].songs.splice(songIndex, 1)[0];
                    
                    if (savePlaylists(playlists)) {
                        message.reply(`✅ Eliminada "${removedSong.title}" de la playlist "${removeFromPlaylist}".`);
                    } else {
                        message.reply('❌ Error al guardar los cambios. Inténtalo de nuevo.');
                    }
                    break;
                    
                case 'list':
                    // Listar todas las playlists o el contenido de una playlist
                    if (!args.length) {
                        // Listar todas las playlists
                        const playlistKeys = Object.keys(playlists);
                        
                        if (playlistKeys.length === 0) {
                            return message.reply('❌ No hay playlists guardadas.');
                        }
                        
                        const playlistsEmbed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setTitle('📋 Playlists Disponibles')
                            .setDescription('Usa `!playlist list [nombre]` para ver el contenido de una playlist específica.')
                            .addFields(
                                playlistKeys.map(name => {
                                    return {
                                        name: `${name} (${playlists[name].songs.length} canciones)`,
                                        value: `Creada por: ${playlists[name].creator}`
                                    };
                                })
                            );
                            
                        message.channel.send({ embeds: [playlistsEmbed] });
                    } else {
                        // Listar contenido de una playlist específica
                        const playlistToShow = args.join(' ').toLowerCase();
                        
                        if (!playlists[playlistToShow]) {
                            return message.reply(`❌ No existe una playlist llamada "${playlistToShow}".`);
                        }
                        
                        const playlist = playlists[playlistToShow];
                        
                        if (playlist.songs.length === 0) {
                            return message.reply(`La playlist "${playlistToShow}" está vacía.`);
                        }
                        
                        const songsEmbed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setTitle(`🎵 Playlist: ${playlistToShow}`)
                            .setDescription(`Creada por: ${playlist.creator} | ${playlist.songs.length} canciones`)
                            .addFields(
                                playlist.songs.map((song, index) => {
                                    return {
                                        name: `${index + 1}. ${song.title}`,
                                        value: `[Link](${song.url})`
                                    };
                                })
                            );
                            
                        message.channel.send({ embeds: [songsEmbed] });
                    }
                    break;
                    
                case 'play':
                    // Reproducir una playlist
                    if (!args.length) {
                        return message.reply('Por favor, especifica el nombre de la playlist a reproducir.');
                    }
                    
                    const voiceChannel = message.member.voice.channel;
                    if (!voiceChannel) {
                        return message.reply('¡Necesitas unirte a un canal de voz primero!');
                    }
                    
                    const playlistToPlay = args.join(' ').toLowerCase();
                    
                    if (!playlists[playlistToPlay]) {
                        return message.reply(`❌ No existe una playlist llamada "${playlistToPlay}".`);
                    }
                    
                    const playlistSongs = playlists[playlistToPlay].songs;
                    
                    if (playlistSongs.length === 0) {
                        return message.reply(`❌ La playlist "${playlistToPlay}" está vacía.`);
                    }
                    
                    const statusMsg = await message.reply(`🔄 Cargando playlist "${playlistToPlay}"...`);
                    
                    // Si es la primera canción, procesarla directamente
                    await processYoutubeUrl(playlistSongs[0].url, message, voiceChannel, statusMsg);
                    
                    // Añadir el resto de canciones a la cola
                    if (playlistSongs.length > 1) {
                        for (let i = 1; i < playlistSongs.length; i++) {
                            try {
                                const videoInfo = await play.video_info(playlistSongs[i].url);
                                
                                const song = {
                                    title: videoInfo.title || playlistSongs[i].title,
                                    url: videoInfo.url,
                                    duration: videoInfo.duration,
                                    thumbnail: videoInfo.thumbnail,
                                    requestedBy: message.author.username
                                };
                                
                                serverQueue = queues.get(guildId); // Actualizar la referencia a la cola
                                
                                if (serverQueue) {
                                    serverQueue.songs.push(song);
                                    console.log(`[DEBUG] Canción de playlist añadida a la cola: ${song.title}`);
                                }
                            } catch (error) {
                                console.error(`[DEBUG] Error al cargar canción de playlist: ${playlistSongs[i].url}`, error);
                            }
                        }
                        
                        message.channel.send(`✅ Se añadieron ${playlistSongs.length - 1} canciones más de la playlist "${playlistToPlay}" a la cola.`);
                    }
                    break;
                    
                case 'delete':
                    // Eliminar una playlist completa
                    if (!args.length) {
                        return message.reply('Por favor, especifica el nombre de la playlist a eliminar.');
                    }
                    
                    const playlistToDelete = args.join(' ').toLowerCase();
                    
                    if (!playlists[playlistToDelete]) {
                        return message.reply(`❌ No existe una playlist llamada "${playlistToDelete}".`);
                    }
                    
                    // Verificar que el usuario sea el creador o tenga permisos de administrador
                    if (playlists[playlistToDelete].creator !== message.author.username && 
                        !message.member.permissions.has('ADMINISTRATOR')) {
                        return message.reply(`❌ Solo el creador o un administrador puede eliminar esta playlist.`);
                    }
                    
                    delete playlists[playlistToDelete];
                    
                    if (savePlaylists(playlists)) {
                        message.reply(`✅ Playlist "${playlistToDelete}" eliminada correctamente.`);
                    } else {
                        message.reply('❌ Error al guardar los cambios. Inténtalo de nuevo.');
                    }
                    break;
                    
                default:
                    message.reply('Acción no válida. Usa: create, add, remove, list, play, delete.');
                    break;
            }
            break;
            
        case 'help':
            const helpEmbed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('🤖 Comandos del Bot')
                .setDescription('Lista de comandos disponibles:')
                .addFields(
                    { name: '!play [URL o búsqueda]', value: 'Reproduce una canción de YouTube. Si pones un término de búsqueda, te mostrará opciones para elegir.' },
                    { name: '!skip', value: 'Salta a la siguiente canción en la cola' },
                    { name: '!stop', value: 'Detiene la reproducción y limpia la cola' },
                    { name: '!pause', value: 'Pausa la reproducción actual' },
                    { name: '!resume', value: 'Reanuda la reproducción pausada' },
                    { name: '!queue', value: 'Muestra la cola de reproducción actual' },
                    { name: '!np / !nowplaying', value: 'Muestra información de la canción actual' },
                    { name: '!volume [0-10]', value: 'Ajusta el volumen de reproducción' },
                    { name: '!loop', value: 'Activa/desactiva el bucle de toda la cola' },
                    { name: '!repeat', value: 'Activa/desactiva la repetición de la canción actual' },
                    { name: '!remove [índice]', value: 'Elimina una canción específica de la cola' },
                    { name: '!clear', value: 'Limpia la cola dejando solo la canción actual' },
                    { name: '!shuffle', value: 'Mezcla las canciones en la cola' },
                    { name: '!forward [segundos]', value: 'Avanza la canción actual (por defecto 10s)' },
                    { name: '!rewind [segundos]', value: 'Retrocede la canción actual (por defecto 10s)' },
                    { name: '!playlist create [nombre]', value: 'Crea una nueva playlist' },
                    { name: '!playlist add [nombre] [URL/búsqueda]', value: 'Añade una canción a la playlist' },
                    { name: '!playlist remove [nombre] [número]', value: 'Elimina una canción de la playlist' },
                    { name: '!playlist list', value: 'Muestra todas las playlists disponibles' },
                    { name: '!playlist list [nombre]', value: 'Muestra las canciones de una playlist' },
                    { name: '!playlist play [nombre]', value: 'Reproduce una playlist' },
                    { name: '!playlist delete [nombre]', value: 'Elimina una playlist' },
                    { name: '!help', value: 'Muestra este mensaje de ayuda' }
                );
                
            message.channel.send({ embeds: [helpEmbed] });
            break;
    }
});

// Agregar función auxiliar para formatear números grandes
function formatNumber(num) {
    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
        return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
}

// Función para convertir la duración de YouTube a segundos
function convertYouTubeDuration(duration) {
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    const hours = (parseInt(match[1]) || 0);
    const minutes = (parseInt(match[2]) || 0);
    const seconds = (parseInt(match[3]) || 0);
    return hours * 3600 + minutes * 60 + seconds;
}

// Solo una vez el login al final del archivo
client.login(process.env.DISCORD_TOKEN);