# homebridge-eureka-e20

Eureka E20 Plus robot vacuum in Apple Home, through the Eureka cloud. Unofficial.

What you get: a Clean switch (on starts or resumes, off sends it to the dock), a Pause
switch, battery level and charging state, and a Fault sensor that opens when the robot
reports a problem.

Behaviour details: every command first checks the robot's current status. Clean on while
the robot is already cleaning does nothing, and Clean off while it is already docked or
returning does nothing. Pause off only resumes a paused robot; it never starts a clean.
If the login is rejected, the plugin backs off (15 minutes, doubling up to an hour) and
after 3 rejections stops trying until you correct the email and password in the plugin
settings and restart.

Limits: needs internet, status can lag by up to the check interval, and the cloud API is
undocumented and may change. Maps, rooms, suction and mop settings stay in the Eureka app.
Commands are confirmed by checking the robot status afterwards, which can take up to about
a minute. If the robot does not confirm, the switch returns to the robot's real state and a
warning is logged.

Setup: install, open the plugin settings, enter the Eureka app email and password, restart
the child bridge. The login session is stored in the Homebridge storage folder in
eureka-e20-tokens.json (readable only by the Homebridge user), together with the account email;
the session is ignored if you change the email in the settings. The password is never logged.
