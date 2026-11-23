# homebridge-eureka-e20

Eureka E20 Plus robot vacuum in Apple Home, through the Eureka cloud. Unofficial.

What you get: a robot vacuum tile in Apple Home (Matter), plus the stage one accessories
described below when the switches are on. The vacuum tile shows the state, battery and
charging, lets you start, pause, resume and send the robot home, and offers the clean
modes Vacuum and Vacuum and mop. Vacuum runs with mop water off. Vacuum and mop runs with
the mop water level set in the options. The switches are a Clean switch (on starts or resumes, off sends it to the dock), a Pause
switch, battery level and charging state, and a Fault sensor that opens when the robot
reports a problem.

Vacuum tile: Homebridge publishes a Matter robot vacuum on its own dedicated Matter
bridge, so it has its own pairing code, separate from the main Homebridge pairing. Add it
in the Home app with that code. It needs Matter enabled in Homebridge and iOS 18.4 or
later. If Matter is not enabled for this bridge, the plugin logs one warning and shows the
Clean and Pause switches instead, so it still works.

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
