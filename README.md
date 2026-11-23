# homebridge-eureka-e20

Eureka E20 Plus robot vacuum in Apple Home, through the Eureka cloud. Unofficial.

What you get: a robot vacuum tile in Apple Home (Matter), plus the stage one accessories
described below when the switches are on. The vacuum tile shows the state, battery and
charging, lets you start, pause, resume and send the robot home, and offers the clean
modes Vacuum and Vacuum and mop. Vacuum runs with mop water off. Vacuum and mop runs with
the mop water level set in the options. The switches are a Clean switch (on starts or resumes, off sends it to the dock), a Pause
switch, battery level and charging state, and a Fault sensor that opens when the robot
reports a problem.

Vacuum tile: Homebridge publishes the Matter robot vacuum on its own Matter server, so the
tile is paired separately, with its own code, not with the main Homebridge pairing. Add it
in the Home app with that code. It needs Matter switched on for this plugin's child bridge
and iOS 18.4 or later. If Matter is not enabled for this bridge, or the tile fails to
publish, the plugin logs a warning and shows the Clean and Pause switches instead, so it
still works.

Things to know about the vacuum tile:
- If you turn matterVacuum off, the old tile stays in Apple Home showing No Response until
  you remove it in the Home app.
- Stop or Idle from Home sends the robot to the dock.
- Starting while the robot is paused resumes the clean with the robot's existing mop water,
  not the selected mode.
- The selected clean mode is kept in memory only, so it goes back to Vacuum after a restart.
- Vacuum and mop is not yet proven on a real robot. The plugin warns in the log if the robot
  reports a different mop water level than the one it was sent.

Options:
- Show as a vacuum in Apple Home (matterVacuum, default on).
- Clean and Pause switches (switches): auto (default) shows them only when the vacuum tile
  is not published, on shows them as well as the tile, off hides them and removes the old
  ones from Apple Home.
- Offer Vacuum and Vacuum and mop on the vacuum tile (cleanModes, default on).
- Mop water level used for Vacuum and mop (mopWater, 1 to 3, default 2).

Behaviour details: every command first checks the robot's current status. Clean on while
the robot is already cleaning does nothing, and Clean off while it is already docked or
returning does nothing. Pause off only resumes a paused robot; it never starts a clean.
If the login is rejected, the plugin backs off (15 minutes, doubling up to an hour) and
after 3 rejections stops trying until you correct the email and password in the plugin
settings and restart.

Limits: needs internet, status can lag by up to the check interval, and the cloud API is
undocumented and may change. Maps, rooms and suction settings stay in the Eureka app.
Commands are confirmed by checking the robot status afterwards, which can take up to about
a minute. If the robot does not confirm, the switch returns to the robot's real state and a
warning is logged.

Setup: install, open the plugin settings, enter the Eureka app email and password, restart
the child bridge. The login session is stored in the Homebridge storage folder in
eureka-e20-tokens.json (readable only by the Homebridge user), together with the account email;
the session is ignored if you change the email in the settings. The password is never logged.
