/**
 * The text of the Help page. Kept as plain data so it can be searched and so wording
 * changes do not touch any layout code.
 *
 * Inline marks: **bold** for names of buttons and screens, `code` for things to type,
 * and [label](#/tab) for a link to another part of the app.
 */

export type Block = string | { list: string[] } | { steps: string[] };

export interface HelpEntry {
  question: string;
  answer: Block[];
}

export interface HelpTopic {
  title: string;
  entries: HelpEntry[];
}

export const HELP: HelpTopic[] = [
  {
    title: 'Everyday control',
    entries: [
      {
        question: 'How do I control a light, or several at once?',
        answer: [
          'On [Lights](#/lights), every card has a switch and a brightness bar. Tap anywhere else on a card to open its full controls.',
          'The top card controls **All lights**. Below it are your zones, then each light on its own. **All off** at the top switches everything off in one tap.',
        ],
      },
      {
        question: 'What are the tabs in a light’s controls for?',
        answer: [
          {
            list: [
              '**Looks**: your saved designs. Tap one to show it.',
              '**Scenes**: Govee’s own animated scenes, plus DIY scenes and snapshots you made in the Govee app.',
              '**Colour**: one colour for the whole light. Save favourites with the + beside the saved colours.',
              '**White**: warm to cool white.',
              '**Paint**: colour the light segment by segment, then **Apply to lights**.',
            ],
          },
        ],
      },
      {
        question: 'Why does a card say “Sending…”?',
        answer: [
          'Govee only accepts so many messages per light at a time through its cloud, so the app sends them in order at a safe pace. A design with several colours is one message per colour, which is why it can take a few seconds to finish.',
          'Lights reached over your own network do not have this limit for on/off, brightness, single colours and white.',
        ],
      },
      {
        question: 'A scene I expected is missing.',
        answer: [
          'Scene lists differ between models, so a scene may exist for the ropes but not the garden lights; the list shows how many of the selected lights have each one.',
          'DIY scenes and snapshots are created in the Govee app. After making one, press the reload button on the **Scenes** tab.',
        ],
      },
    ],
  },
  {
    title: 'Looks and movement',
    entries: [
      {
        question: 'What is a look?',
        answer: [
          'A look is your own design: a palette of up to eight colours plus a pattern that spreads them over the lights. Create one on [Looks](#/looks) with **New look**, press **Try** to see it on the lights without saving, then **Save look**.',
          'A saved look can be shown from any light’s controls and used in schedules.',
        ],
      },
      {
        question: 'What do the patterns do?',
        answer: [
          {
            list: [
              '**Gradient**: the colours blend along each light.',
              '**Blocks**: each light is split into equal bands, one per colour.',
              '**Alternating**: the colours repeat segment by segment.',
              '**One per light**: each light takes the next colour in the palette.',
              '**Solid**: every light shows the first colour.',
              '**Painted**: a design you made on the **Paint** tab and saved.',
            ],
          },
        ],
      },
      {
        question: 'How do I make the colours change slowly?',
        answer: [
          'Edit a look and turn on **Movement**, then choose how long one full loop through the palette takes, from 10 minutes to 4 hours. The preview at the top plays it sped up.',
          {
            list: [
              '**Solid**: all the lights change colour together.',
              '**One per light**: colours travel from light to light.',
              'Other patterns: colours flow along each light.',
            ],
          },
          'Solid and One per light move in the smallest steps. On lights reached over your own network they step every few seconds; through Govee’s cloud a step is about every minute.',
        ],
      },
      {
        question: 'How do I stop a moving look?',
        answer: [
          'Apply anything else, switch the lights off, or open the light’s controls and press **Hold here** to keep the colours showing at that moment.',
          'A moving look carries on until then, including after the app restarts.',
        ],
      },
      {
        question: 'Can I get a look from a description or a photo?',
        answer: [
          '**From photo** in the look editor picks a palette out of any picture.',
          '**Describe** suggests three designs from words such as “cosy autumn evening”, and “warmer, less purple” refines the one you are editing. It needs an Anthropic API key in the `.env` file as `ANTHROPIC_API_KEY`; without one the box is replaced by a short note.',
        ],
      },
      {
        question: 'Why can’t a look flash, chase or twinkle?',
        answer: [
          'Every colour change is a separate message to the light, and they cannot be sent fast enough for quick effects. Use a Govee scene for those; looks are for still designs and slow movement.',
        ],
      },
    ],
  },
  {
    title: 'Zones and lights joined end to end',
    entries: [
      {
        question: 'What is a zone for?',
        answer: ['A zone is a named group of lights, such as “Front yard”, that you can switch, colour and schedule together. Create one with **New zone** on [Lights](#/lights). A light can be in several zones.'],
      },
      {
        question: 'Two of my lights run one after the other. How do I make them act as one?',
        answer: [
          {
            steps: [
              'Create a zone containing just those lights and turn on **Joined end to end**.',
              'Put them in order, from where the run starts to where it ends.',
              'Press **Save and test**. The run should light green at its start, blue in the middle and red at its end.',
              'If one light runs the wrong way, tick **Reversed** for it. If they are in the wrong order, move them. Test again.',
            ],
          },
          'Looks, painting and movement then run across the whole run. This applies whenever all of its lights are included in what you are controlling: the zone itself, a bigger zone, or all lights. A single light picked on its own shows the whole design by itself.',
        ],
      },
      {
        question: 'How do I make two runs mirror each other?',
        answer: ['Start both at the same end, for example the street end of a path. A gradient then sweeps the same way up both sides.'],
      },
      {
        question: 'A design comes out backwards on one light.',
        answer: ['Tick **Reversed** for that light: in the zone editor if it is part of a joined run, otherwise under **Lights** in [Settings](#/settings).'],
      },
      {
        question: 'What does the order of lights in Settings do?',
        answer: ['It sets the order lights are listed in, and the order colours are handed out in for a **One per light** look. A joined run counts as one light and takes one colour.'],
      },
    ],
  },
  {
    title: 'Schedules',
    entries: [
      {
        question: 'How do I set up a schedule?',
        answer: [
          'On [Schedules](#/schedules) press **New schedule**. Choose the lights, what should happen, when it starts, and optionally when the lights turn off again.',
          {
            list: [
              'Start and end can be a clock time, or sunrise or sunset with an offset such as 30 minutes before.',
              'An end time earlier than the start means the following morning.',
              '**Days** limits it to certain days of the week; **Time of year** to a range of dates, such as 1 December to 6 January.',
              'The play button on a schedule’s card runs it straight away.',
            ],
          },
        ],
      },
      {
        question: 'Sunrise and sunset do not work.',
        answer: ['They need to know where you are. Enter your latitude and longitude under **Location** in [Settings](#/settings). The location is only used on this computer to work out the times.'],
      },
      {
        question: 'How do I know the lights really turned off?',
        answer: [
          'After a schedule switches lights off, the app asks each light whether it is off, about 1, 3, 10, 30 and 60 minutes later, and sends “off” again to any that is still on or cannot be reached. It stops as soon as every light has been seen off.',
          'The schedule’s card then says **confirmed off**, or names the lights that are still on or unreachable; those lights also get a red note on [Lights](#/lights).',
          'A light stops being checked as soon as it is seen off, or as soon as you do anything else with it in this app, so turning one back on yourself is respected.',
        ],
      },
      {
        question: 'What if two schedules overlap?',
        answer: ['Whichever runs last wins. When two start in the same minute, one limited to a time of year wins over an everyday one, so a holiday schedule can sit on top of your normal evening one.'],
      },
      {
        question: 'A schedule did not run.',
        answer: [
          {
            list: [
              'Schedules run on the computer hosting Afterglow, so it must be on and awake. A start missed by more than ten minutes is skipped rather than run late.',
              'Check the schedule is switched on and that its card does not show a problem, such as a missing location or a deleted look.',
              'If the Govee app has schedules for the same lights, they may be undoing this one. Turn those off.',
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'Local control and Govee’s cloud',
    entries: [
      {
        question: 'What is the difference?',
        answer: [
          'The app can reach a light two ways. Straight over your home network is instant, uses none of your Govee allowance and works when the internet is down, but can only set power, brightness, a single colour or white. Through Govee’s cloud is slower and rationed, but is the only way to send multi-colour designs and Govee scenes.',
          'The app picks the best route for each command by itself.',
        ],
      },
      {
        question: 'How do I turn on local control?',
        answer: [
          'In the Govee Home app, open each light’s settings and switch on **LAN Control**. Within a minute or two the light shows as “reached locally” under **Lights** in [Settings](#/settings). Nothing needs changing here.',
          'Turning it on means the light can no longer relay Govee Bluetooth sensors, and uses slightly more standby power.',
        ],
      },
      {
        question: 'LAN Control is on, but a light still says “reached through the cloud”.',
        answer: [
          {
            list: [
              'Give it a few minutes, then switch the light’s power off and on at the plug.',
              'The computer running Afterglow must be on the same network as the lights. Some routers and mesh systems block the discovery messages between Wi-Fi bands or guest networks.',
              'If the **Connection** section in Settings says local control is unavailable, another app on the same computer is already using the port it needs.',
              'On a Mac, allow Node to accept incoming connections if asked.',
            ],
          },
        ],
      },
      {
        question: 'What are “requests”, and can I run out?',
        answer: [
          'Each command sent through Govee’s cloud is one request, and Govee limits how many an account may send in a day. **Connection** in [Settings](#/settings) shows today’s count. Commands sent over your own network do not count.',
          'Ordinary use stays far below the limit. Moving looks sent through the cloud are held to a small hourly allowance per light and pause for the rest of the day if the account gets close to the limit.',
        ],
      },
    ],
  },
  {
    title: 'Using the Govee app alongside',
    entries: [
      {
        question: 'Do I still need the Govee app?',
        answer: [
          'Yes, for setup rather than daily use: adding lights, Wi-Fi, firmware updates, the LAN Control switch, music mode, and creating DIY scenes and snapshots. Keep the lights in your Govee account; this app gets its list of lights from it.',
        ],
      },
      {
        question: 'Should I turn off my schedules in the Govee app?',
        answer: ['Yes, for any lights you schedule here. The two apps do not know about each other, so both would run and the last one would win. The turn-off check also only covers schedules made in this app.'],
      },
      {
        question: 'Will a change in one app show in the other?',
        answer: [
          {
            list: [
              'Power, brightness and a single colour set in the Govee app appear here within about 30 seconds for lights reached locally, and within ten minutes otherwise.',
              'Scenes and segment colours set in the Govee app cannot be read back, so this app keeps showing the last thing it applied.',
              'A moving look repaints its lights at every step, so a colour changed in the Govee app will be overwritten. Switching the light off there does stop the movement.',
              'A light renamed in the Govee app updates here after **Rescan lights** in Settings, unless you gave it its own name here.',
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'Phones, other devices and assistants',
    entries: [
      {
        question: 'How do I open this on my phone?',
        answer: [
          '**Open on another device** in [Settings](#/settings) lists the addresses that work. The home-network address works on your Wi-Fi. If the computer and your phone are both signed in to the same Tailscale network, the Tailscale address works from anywhere.',
          'In Safari, choose **Share**, then **Add to Home Screen**, to open it like an app.',
        ],
      },
      {
        question: 'Can I stop other people on my network using it?',
        answer: ['Yes. Set `ACCESS_TOKEN` to a passphrase in the `.env` file and restart. The page, and any assistant connecting to it, must then supply the passphrase.'],
      },
      {
        question: 'How do I connect an AI assistant?',
        answer: [
          '**AI agents** in [Settings](#/settings) lists the address to give it and a ready-made command for Claude Code. A connected assistant can see the lights, change them, and manage looks and schedules; everything it does appears under **Recent activity**.',
          'The assistant has to run on a machine that can reach the address: this computer, another on your network, or one on your Tailscale network. One hosted in the cloud cannot reach those addresses.',
        ],
      },
    ],
  },
  {
    title: 'When something looks wrong',
    entries: [
      {
        question: 'A light has a red message under it.',
        answer: [
          'The last command to that light failed, or a scheduled turn-off could not be confirmed. The message says which. It clears the next time a command to that light succeeds, so try switching it again; if it keeps failing, check the light has power and is on Wi-Fi.',
        ],
      },
      {
        question: 'The lights do not match what the app shows.',
        answer: [
          'Govee reports a light’s power, brightness and single colour, but not which scene is running or its segment colours. For those the app shows what it last applied, which can be out of date if something else changed the light. Applying a look or colour again brings the two back in step.',
        ],
      },
      {
        question: 'A banner says the app can’t reach Govee.',
        answer: [
          'Govee’s service or your internet connection is down, or the API key in the `.env` file is wrong. Lights reached locally still respond to on/off, brightness, single colours and white in the meantime.',
        ],
      },
      {
        question: 'It says “Demo”.',
        answer: ['No Govee API key is set, so the app is showing simulated lights. Request a key in the Govee Home app under Profile, Settings, Apply for API Key, put it in the `.env` file as `GOVEE_API_KEY`, and restart.'],
      },
      {
        question: 'A moving look stopped by itself.',
        answer: [
          {
            list: [
              'Something else was applied to those lights, or they were switched off, possibly by a schedule.',
              'A light that failed three steps in a row is dropped so it is not retried all night.',
              'Looks moving through Govee’s cloud pause for the rest of the day when the account is close to its daily request limit. **Recent activity** in Settings says when that happens.',
            ],
          },
        ],
      },
      {
        question: 'Is my setup backed up? How do I get something back?',
        answer: [
          'Yes. A copy of your looks, zones, schedules and settings is saved every day and kept for two weeks. **Backups** in [Settings](#/settings) lists them; press **Restore** beside one to go back to it. The setup being replaced is saved first, so a restore can itself be undone.',
          'Those copies are on the same disk as the app. Use **Download a backup** now and then and keep the file somewhere else; **Restore from a file** brings it back, including on a new computer.',
          'Backups do not include your Govee key or passphrase, which stay in the `.env` file.',
        ],
      },
    ],
  },
];
