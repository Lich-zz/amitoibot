const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const moment = require('moment-timezone');
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

const activeChannels = new Map();
const serverEvents = new Map();
const activeUserTimers = new Map();
let lastServerStatus = '';
let serverStatusDelay = 5;
let serverStatus = 1;
const bossesSchedule = [
    { hour: 2, minute: 0 },
    { hour: 14, minute: 0 },
    { hour: 17, minute: 0 },
    { hour: 21, minute: 0 },
    { hour: 23, minute: 0 }
];

let currentNightStart = null;
let currentNightEnd = null;

const localCommands = [
    {
        name: 'startamitoi',
        description: 'Set up an alert for the specified interval.',
        options: [
            {
                name: 'hours',
                type: 4, // INTEGER
                description: 'Set the alert interval (1, 2, 4, or 8 hours)',
                required: true,
                choices: [
                    { name: '1 hour', value: 1 },
                    { name: '2 hours', value: 2 },
                    { name: '4 hours', value: 4 },
                    { name: '8 hours', value: 8 }
                ]
            }
        ]
    },
    {
        name: 'getamitoi',
        description: 'Get amitoy expedition time',
    },
    {
        name: 'night',
        description: 'Check the current night status or time until next night.',
    },
    {
        name: 'addevent',
        description: 'Add an event reminder.',
		default_member_permissions: PermissionsBitField.Flags.ManageRoles.toString(), // Додаємо обмеження   
        options: [
            {
                name: 'message',
                type: 3,
                description: 'Message to remind',
                required: true,
            },
            {
                name: 'time',
                type: 3,
                description: 'Event time in HH:MM (24-hour format)',
                required: true,
            },
            {
                name: 'timezone',
                description: 'Select your timezone',
                type: ApplicationCommandOptionType.String,
                autocomplete: true
            }
        ]
    },
    {
        name: 'listevents',
        description: 'List all scheduled events.',
    }
];

// Function to set up night intervals
function initializeNightCycle() {
    const nightSchedule = getNightSchedule();
    const now = moment.tz('Europe/Kyiv');

    for (const night of nightSchedule) {
        if (night.start.isAfter(now)) {
            currentNightStart = night.start;
            currentNightEnd = night.end;
            return;
        } else if (night.start.isBefore(now) && night.end.isAfter(now)) {
            currentNightStart = night.start;
            currentNightEnd = night.end;
            return;
        }
    }

    currentNightStart = nightSchedule[0].start.clone().add(1, 'day');
    currentNightEnd = currentNightStart.clone().add(30, 'minutes');
}

function getNightSchedule() {
    const schedule = [];
    const now = moment.tz('Europe/Kyiv');
    const cycleStart = moment.tz("2024-11-06T16:00", 'Europe/Kyiv');  // Початок початкового циклу

    // Зсув, який допоможе знайти найближчий нічний інтервал
    let nightStart = cycleStart;

    // Знаходимо найближчий початок ночі, що ще не минув
    while (nightStart.isBefore(now)) {
        nightStart.add(2.5, 'hours'); // Кожна ніч розпочинається через 2.5 години від попередньої
    }

    // Додаємо 24 майбутні нічні інтервали
    for (let i = 0; i < 24; i++) {
        const nightEnd = nightStart.clone().add(30, 'minutes'); // Ніч триває 30 хвилин
        schedule.push({ start: nightStart.clone(), end: nightEnd });
        nightStart.add(2.5, 'hours'); // Переходимо до наступної ночі
    }

    return schedule;
}

initializeNightCycle();

// Function to send messages to active channels
async function sendMessageToActiveChannels(messageContent, serverId) {
    activeChannels.forEach((channels, guildId) => {
        channels.forEach((channelId) => {
            if (serverId && channelId !== serverId) {
                return;
            }

            const guild = client.guilds.cache.get(guildId);
            const channel = guild?.channels.cache.get(channelId);

            if (channel && channel.isTextBased() && channel.permissionsFor(guild.members.me).has('SendMessages')) {
                try {
                    channel.send(messageContent);
                } catch (error) {
                    console.error(`Failed to send message in ${channel.name} of ${guild.name}: ${error.message}`);
                }
            }
        });
    });
}

// Define slash commands and their behavior
client.once('ready', async () => {
	console.log(`Logged in as ${client.user.tag}!`);
    await checkAndUpdateCommands();
	initializeActiveChannels();
});

// Ініціалізація активних каналів при запуску бота
function initializeActiveChannels() {
    client.guilds.cache.forEach(guild => {
        const channels = [];
        guild.channels.cache.forEach(channel => {
            if (
                channel.isTextBased() &&
                channel.members.has(client.user.id) &&
                channel.permissionsFor(guild.members.me).has('SendMessages')
            ) {
                channels.push(channel.id);
                console.log(`Active channel set to: ${channel.name} in guild: ${guild.name}`);
            }
        });
        if (channels.length > 0) {
            activeChannels.set(guild.id, channels);
        }
    });
}

// Оновлення activeChannels при додаванні бота до нової гільдії
client.on('guildCreate', guild => {
  initializeActiveChannels();
});

// Видалення запису з activeChannels при видаленні гільдії
client.on('guildDelete', guild => {
    if (activeChannels.has(guild.id)) {
        activeChannels.delete(guild.id);
        console.log(`Removed guild from active channels: ${guild.name}`);
    }
});

client.on('channelUpdate', (oldChannel, newChannel) => {
    if (newChannel.isTextBased() && newChannel.guild) {
        const guildId = newChannel.guild.id;
        
        // Перевірка, чи бот має дозволи на надсилання повідомлень у новому каналі
        const botHasPermission = newChannel.permissionsFor(newChannel.guild.members.me).has('SendMessages');
        const isInActiveChannels = activeChannels.has(guildId) && activeChannels.get(guildId).includes(newChannel.id);

        if (botHasPermission && !isInActiveChannels) {
            // Додаємо канал до активних, якщо бот отримав дозволи
            if (!activeChannels.has(guildId)) activeChannels.set(guildId, []);
            activeChannels.get(guildId).push(newChannel.id);
            console.log(`Bot was added to active channel: ${newChannel.name} in guild: ${newChannel.guild.name}`);
        } else if (!botHasPermission && isInActiveChannels) {
            // Видаляємо канал з активних, якщо бот втратив дозволи
            const channels = activeChannels.get(guildId).filter(id => id !== newChannel.id);
            if (channels.length === 0) activeChannels.delete(guildId);
            else activeChannels.set(guildId, channels);
            console.log(`Bot was removed from active channel: ${newChannel.name} in guild: ${newChannel.guild.name}`);
        }
    }
});

// Оновлення активних каналів, якщо гільдія була змінена
client.on('guildUpdate', (oldGuild, newGuild) => {
    const guildId = newGuild.id;
    const channels = [];

    newGuild.channels.cache.forEach(channel => {
        if (
            channel.isTextBased() &&
            channel.permissionsFor(newGuild.members.me).has('SendMessages')
        ) {
            channels.push(channel.id);
        }
    });

    if (channels.length > 0) {
        activeChannels.set(guildId, channels);
        console.log(`Updated active channels for guild: ${newGuild.name}`);
    } else if (activeChannels.has(guildId)) {
        activeChannels.delete(guildId);
        console.log(`Removed all active channels for guild: ${newGuild.name}`);
    }
});

// Додавання нового каналу в activeChannels, якщо бот має відповідні дозволи
client.on('channelCreate', channel => {
    initializeActiveChannels();
});

// Видалення каналу з activeChannels, якщо він був видалений
client.on('channelDelete', channel => {
    if (channel.isTextBased() && channel.guild && activeChannels.has(channel.guild.id)) {
        const guildChannels = activeChannels.get(channel.guild.id);
        const channelIndex = guildChannels.indexOf(channel.id);
        
        if (channelIndex !== -1) {
            guildChannels.splice(channelIndex, 1);
            console.log(`Removed channel: ${channel.name} from guild: ${channel.guild.name}`);
            
            // Якщо немає активних каналів у гільдії, видаляємо запис для гільдії
            if (guildChannels.length === 0) {
                activeChannels.delete(channel.guild.id);
            }
        }
    }
});

// Function to check schedule and send notifications
function checkSchedule() {
    const now = moment.tz('Europe/Kyiv').startOf('minute');

// Check for events and notify
    serverEvents.forEach((events, serverId) => {
        events.forEach((event, index) => {
            const eventTimeInUserTZ = moment.tz(event.time, 'Europe/Kyiv');

            // Notify 5 minutes before the event
            if (now.isSame(eventTimeInUserTZ.clone().subtract(5, 'minutes'), 'minute')) {
                sendMessageToActiveChannels(`🔔 "${event.message}" will start in 5 minutes!`, serverId);
            }

            if (now.isSame(eventTimeInUserTZ, 'minute')) {
                sendMessageToActiveChannels(`🔔 "${event.message}" Starting Now!`, serverId);
                serverEvents.get(serverId).splice(index, 1);
            }
        });
    });
	
	if (!serverStatus) return;
	
    // Notify 5 minutes before night starts
    if (now.isSame(currentNightStart.clone().subtract(5, 'minutes'), 'minute')) {
        sendMessageToActiveChannels('⏰ **Night starts in 5 minutes!** Be careful!');
    }

    // Notify when night starts
    if (now.isSame(currentNightStart, 'minute')) {
        sendMessageToActiveChannels('🌙 **Night has started!** Be careful!');
    }

    // Notify when night ends
    if (now.isSame(currentNightEnd, 'minute')) {
        sendMessageToActiveChannels('🌅 **The night is over!** You are safe again.');

        // Update to the next night in the schedule
        const nightSchedule = getNightSchedule();
        for (const night of nightSchedule) {
            if (night.start.isAfter(now)) {
                currentNightStart = night.start;
                currentNightEnd = night.end;
                break;
            }
        }
    }

    // Boss appearance notifications
    bossesSchedule.forEach((boss) => {
        let bossTime = moment.tz({ hour: boss.hour, minute: boss.minute }, 'Europe/Kyiv');
		
		// Якщо час боса вже пройшов сьогодні, переносимо його на наступний день
		if (bossTime.isBefore(now)) {
			bossTime = bossTime.add(1, 'day'); // переносимо на наступний день
		}
		
        if (now.isSame(bossTime.clone().subtract(5, 'minutes'), 'minute')) {
            sendMessageToActiveChannels(`⏰ **Bosses will appear in 5 minutes!** Prepare!`);
        }

        if (now.isSame(bossTime, 'minute')) {
            sendMessageToActiveChannels(`⚔️ **Bosses have appeared!** Get ready for battle!`);
        }
    });
}

// Command interaction handling
client.on('interactionCreate', async interaction => {
	if (interaction.isAutocomplete()) {
		const focusedOption = interaction.options.getFocused(); // Get the user's input
		const allTimezones = moment.tz.names(); // Retrieve all timezones

		// Filter timezones based on whether they contain the user's input, case-insensitive
		const filteredTimezones = allTimezones.filter(tz => tz.toLowerCase().includes(focusedOption.toLowerCase()));

		// Return a maximum of 25 results (Discord's limit for autocomplete)
		await interaction.respond(
			filteredTimezones.slice(0, 25).map(timezone => ({
				name: timezone,
				value: timezone
			}))
		);
	}
	
    if (!interaction.isChatInputCommand()) return;

    const now = moment.tz('Europe/Kyiv');
    const nightSchedule = getNightSchedule();
	
	if (interaction.commandName === 'startamitoi') {
		const hours = interaction.options.getInteger('hours');
		const intervalMs = hours * 60 * 60 * 1000; // Перетворюємо години в мілісекунди
		const userId = interaction.user.id;
		const endTime = moment().add(hours, 'hours'); // Час завершення у форматі moment

		// Очищаємо попередній таймер, якщо існує
		if (activeUserTimers.has(userId)) {
			clearTimeout(activeUserTimers.get(userId).timer);
		}

		// Створюємо новий таймер
		const timer = setTimeout(async () => {
			try {
				await interaction.user.send(`⏰ **Reminder!** Your ${hours}-hour Amitoy expedition ended!`);
			} catch (error) {
				console.error(`Failed to send DM to user ${interaction.user.tag}: ${error.message}`);
			}
			activeUserTimers.delete(userId);
		}, intervalMs);

		// Зберігаємо таймер і час завершення
		activeUserTimers.set(userId, { timer, endTime });

		await interaction.reply({ content: `✅ Alert set for ${hours} hour(s)!`, ephemeral: true });
	}

	if (interaction.commandName === 'getamitoi') {
		const userId = interaction.user.id;

		if (activeUserTimers.has(userId)) {
			const { endTime } = activeUserTimers.get(userId);
			const timeLeft = moment.duration(endTime.diff(moment()));

			const hours = timeLeft.hours();
			const minutes = timeLeft.minutes();
			const seconds = timeLeft.seconds();

			await interaction.reply({
				content: `⏳ Time remaining: **${hours}h ${minutes}m ${seconds}s**`,
				ephemeral: true
			});
		} else {
			await interaction.reply({
				content: `🚫 No active timer found for you.`,
				ephemeral: true
			});
		}
	}

    if (interaction.commandName === 'night') {
        const currentNight = nightSchedule.find(night => night.start.isBefore(now) && night.end.isAfter(now));
        const nextNightStart = currentNightStart;

        if (currentNight) {
            const minutesTillDay = currentNight.end.diff(now, 'minutes');
            await interaction.reply(`🌙 **It's night time!** ${minutesTillDay} minutes until day.`);
        } else {
            const minutesTillNight = nextNightStart.diff(now, 'minutes');
            const hours = Math.floor(minutesTillNight / 60);
            const minutes = minutesTillNight % 60;
			if (minutes < 0) {
				console.log(nextNightStart);
				console.log(currentNight);
			}
            const timeString = hours > 0 
                ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes > 0 ? `${minutes} minute${minutes > 1 ? 's' : ''}` : ''}` 
                : `${minutes} minute${minutes > 1 ? 's' : ''}`;

            await interaction.reply(`🌘 **Time until next night:** ${timeString}.`);
        }
    }

    if (interaction.commandName === 'addevent') {
		if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
			await interaction.reply({
				content: '❌ You do not have permission to use this command.',
				ephemeral: true,
			});
			return;
		}
        const eventMessage = interaction.options.getString('message');
        const eventTime = interaction.options.getString('time');
		const eventTimeZone = interaction.options.getString('timezone') || 'Europe/Kyiv';

        const timeMatch = eventTime.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!timeMatch) {
            await interaction.reply('❌ Invalid time format! Use HH:MM (24-hour format).');
            return;
        }

		if (!moment.tz.zone(eventTimeZone)) {
			await interaction.reply('❌ Invalid timezone! Use a standard name, such as Europe/Kyiv or America/New_York.');
			return;
		}

        const eventDateTime = moment.tz(`${eventTime}`, 'HH:mm', eventTimeZone);

        if (!serverEvents.has(interaction.channelId)) {
            serverEvents.set(interaction.channelId, []);
        }

        const event = {
            message: eventMessage,
            time: eventDateTime,
            timeZone: eventTimeZone, 
        };

        serverEvents.get(interaction.channelId).push(event);
		sendMessageToActiveChannels(`✅ Event "${event.message}" scheduled at ${eventDateTime.format('HH:mm')} (${eventTimeZone}).`, interaction.channelId);
		await interaction.reply(`✅ Event "${event.message}" scheduled at ${eventDateTime.format('HH:mm')} (${eventTimeZone}).`);
    }

    if (interaction.commandName === 'listevents') {
        const events = serverEvents.get(interaction.channelId);
        if (!events || events.length === 0) {
            await interaction.reply('📅 **No scheduled events.**');
            return;
        }

       	const eventList = events.map(event => `- ${event.message} at <t:${moment.tz(event.time, event.timeZone).unix()}:F>`).join('\n');
        await interaction.reply(`📅 **Scheduled Events:**\n${eventList}`);
    }
});

// Функція для перевірки статусу сервера
async function checkServerStatus() {
    try {
        const response = await axios.get('https://www.playthroneandliberty.com/en-us/support/server-status');
        const html = response.data;
        const $ = cheerio.load(html);

        const elements = $('.ags-ServerStatus-content-serverStatuses-server-item-label');

        // Шукаємо елемент, що містить слово "Justice"
        let serverStatus = '';
        elements.each((i, el) => {
            const text = $(el).text().trim();
            if (text.includes('Justice')) {
                serverStatus = $(el).attr('aria-label');
                return false; // Зупиняємо цикл, коли знаходимо перший збіг
            }
        });
        // Перевіряємо, чи статус змінився
        if (serverStatus && serverStatus !== lastServerStatus) {
            // Ваша функція для відправлення повідомлення, наприклад, у Discord:
            sendMessageToActiveChannels(`🔔 New server status: ${serverStatus}`);

            // Оновлюємо попередній статус
            lastServerStatus = serverStatus;
        } else {
           // console.log('Server status stay as :' + serverStatus);
        }

		if (lastServerStatus.includes('Maintenance')) {
			serverStatusDelay = 5;
			serverStatus = 0;
		} else {
			serverStatusDelay = 60;
			serverStatus = 0;
		}
    } catch (error) {
        console.error('Error server Status:', error);
    }
}

// Функція для перевірки і оновлення команд
async function checkAndUpdateCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    try {
        // Отримуємо список зареєстрованих команд
        const registeredCommands = await rest.get(Routes.applicationCommands(client.user.id));
        const registeredCommandNames = registeredCommands.map(cmd => cmd.name);

        // Знаходимо відсутні команди
        const missingCommands = localCommands.filter(cmd => !registeredCommandNames.includes(cmd.name));

        // Додаємо відсутні команди
        if (missingCommands.length > 0) {
            await rest.put(Routes.applicationCommands(client.user.id), {
                body: [...registeredCommands, ...missingCommands]
            });
            console.log(`Added missing commands: ${missingCommands.map(cmd => cmd.name).join(', ')}`);
        } else {
            console.log('No missing commands found.');
        }
    } catch (error) {
        console.error('Error checking or updating commands:', error);
    }
}

// Періодична перевірка команд кожну годину
setInterval(checkAndUpdateCommands, 60 * 60 * 1000);

// Schedule check function
setInterval(checkSchedule, 60000);

// Виклик функції з інтервалом, наприклад, кожні 5/60 хвилин
setInterval(checkServerStatus, serverStatusDelay * 60 * 1000);

client.login(process.env.TOKEN);
