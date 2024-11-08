const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const moment = require('moment-timezone');
require('dotenv').config();

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
const bossesSchedule = [
    { hour: 13, minute: 0 },
    { hour: 16, minute: 0 },
    { hour: 20, minute: 0 },
    { hour: 22, minute: 0 },
    { hour: 01, minute: 0 },
];

let currentNightStart = null;
let currentNightEnd = null;

// Function to set up night intervals
function initializeNightCycle() {
    const nightSchedule = getNightSchedule();
    const now = moment();

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

// Function to generate night schedule
function getNightSchedule() {
    const schedule = [];
    const cycleStart = moment.tz("2024-11-06T14:30", 'Europe/Kyiv'); 

    for (let i = 0; i < 24; i++) {
        const nightStart = cycleStart.clone().add(i * 2.5, 'hours');
        const nightEnd = nightStart.clone().add(30, 'minutes');
        schedule.push({ start: nightStart, end: nightEnd });
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

    // Define commands
    const commands = [
        {
            name: 'night',
            description: 'Check the current night status or time until next night.',
        },
        {
            name: 'addevent',
            description: 'Add an event reminder.',
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
                    description: 'Event time in HH:MM (24-hour format) ( default timezone Europe/Kyiv GMT+1 )',
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

    // Define permissions for commands (use .toString() to serialize the permission value)
    const permissions = PermissionsBitField.Flags.ManageRoles.toString();

    // Add permissions to the command registration
    commands[1].default_member_permissions = permissions;
    const clientUserId = String(client.user.id); 

    // Register commands globally
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
         await rest.put(Routes.applicationCommands(clientUserId), { body: commands });
        console.log('Slash commands registered.');
    } catch (error) {
        console.error(error);
    }

    // Initialize active channels
    client.guilds.cache.forEach(guild => {
        const channels = [];
        guild.channels.cache.forEach(channel => {
            if (
                channel.isTextBased() &&
                channel.members.has(client.user.id) &&
                channel.permissionsFor(guild.members.me).has('SendMessages')
            ) {
                channels.push(channel.id);
                activeChannels.set(guild.id, channels);
                console.log(`Active channel set to: ${channel.name} in guild: ${guild.name}`);
            }
        });
    });
});

// Function to check schedule and send notifications
function checkSchedule() {
    const now = moment();

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

    // Boss appearance notifications
    bossesSchedule.forEach((boss) => {
        const bossTime = moment.tz({ hour: boss.hour, minute: boss.minute }, 'Europe/Kyiv');

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

    const now = moment();
    const nightSchedule = getNightSchedule();

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
            const timeString = hours > 0 
                ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes > 0 ? `${minutes} minute${minutes > 1 ? 's' : ''}` : ''}` 
                : `${minutes} minute${minutes > 1 ? 's' : ''}`;

            await interaction.reply(`🌘 **Time until next night:** ${timeString}.`);
        }
    }

    if (interaction.commandName === 'addevent') {
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

// Schedule check function
setInterval(checkSchedule, 60000);

client.login(process.env.TOKEN);
