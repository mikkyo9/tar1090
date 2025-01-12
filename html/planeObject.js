"use strict";

function PlaneObject(icao) {
	// Info about the plane
	this.icao      = icao;
	this.icaorange = findICAORange(icao);
	this.flight    = null;
	this.squawk    = null;
	this.selected  = false;
	this.category  = null;
	this.dataSource = null;

	// Basic location information
	this.altitude       = null;
	this.altitude_cached = null;
	this.alt_baro       = null;
	this.alt_geom       = null;

	this.speed          = null;
	this.gs             = null;
	this.ias            = null;
	this.tas            = null;

	this.track          = null;
	this.track_rate     = null;
	this.mag_heading    = null;
	this.true_heading   = null;
	this.mach           = null;
	this.roll           = null;
	this.nav_altitude   = null;
	this.nav_heading    = null;
	this.nav_modes      = null;
	this.nav_qnh        = null;
	this.rc				= null;

	this.nac_p			= null;
	this.nac_v			= null;
	this.nic_baro		= null;
	this.sil_type		= null;
	this.sil			= null;

	this.baro_rate      = null;
	this.geom_rate      = null;
	this.vert_rate      = null;

	this.version        = null;

	this.prev_position = null;
	this.prev_time = null;
	this.prev_track = null;
	this.position  = null;
	this.sitedist  = null;

	// Data packet numbers
	this.messages  = null;
	this.rssi      = null;
	this.rssa      = null;
	this.rindex    = 0;

	// Track history as a series of line segments
	this.elastic_feature = null;
	this.track_linesegs = [];
	this.history_size = 0;

	// Track (direction) at the time we last appended to the track history
	this.tail_track = null;
	this.tail_true = null;
	// Timestamp of the most recent point appended to the track history
	this.tail_update = null;

	// When was this last updated (receiver timestamp)
	this.last_message_time = 0;
	this.position_time = 0;

	// When was this last updated (seconds before last update)
	this.seen = null;
	this.seen_pos = null;

	// Display info
	this.visible = true;
	this.marker = null;
	this.markerStyle = null;
	this.markerIcon = null;
	this.markerStyleKey = null;
	this.markerSvgKey = null;
	this.filter = {};

	// start from a computed registration, let the DB override it
	// if it has something else.
	this.registration = registration_from_hexid(this.icao);
	this.icaotype = null;
	this.typeDescription = null;
	this.wtc = null;


	this.trail_features = new ol.Collection();

	this.layer = new ol.layer.Vector({
		name: this.icao,
		source: new ol.source.Vector({
			features: this.trail_features,
		})
	});

	trailGroup.push(this.layer);

	// request metadata
	getAircraftData(this.icao).done(function(data) {
		if ("r" in data) {
			this.registration = data.r;
		}

		if ("t" in data) {
			this.icaotype = data.t;
		}

		if ("desc" in data) {
			this.typeDescription = data.desc;
		}

		if ("wtc" in data) {
			this.wtc = data.wtc;
		}

		if (this.selected) {
			refreshSelected();
		}
		data = null;
	}.bind(this));
}

PlaneObject.prototype.logSel = function(loggable) {
	if (debug && this.selected && !SelectedAllPlanes)
		console.log(loggable);
	return;
}

PlaneObject.prototype.isFiltered = function() {
	if (this.filter.minAltitude !== undefined && this.filter.maxAltitude !== undefined) {
		if (this.altitude == null) {
			return true;
		}
		var planeAltitude = this.altitude === "ground" ? 0 : convert_altitude(this.altitude, this.filter.altitudeUnits);
		return planeAltitude < this.filter.minAltitude || planeAltitude > this.filter.maxAltitude;
	}

	// filter out ground vehicles
	if (typeof this.filter.groundVehicles !== 'undefined' && this.filter.groundVehicles === 'filtered') {
		if (typeof this.category === 'string' && this.category.startsWith('C')) {
			return true;
		}
	}

	// filter out blocked MLAT flights
	if (typeof this.filter.blockedMLAT !== 'undefined' && this.filter.blockedMLAT === 'filtered') {
		if (typeof this.icao === 'string' && this.icao.startsWith('~')) {
			return true;
		}
	}

	return false;
}

PlaneObject.prototype.updateTail = function() {

	this.tail_update = this.prev_time;
	this.tail_track = this.prev_track;
	this.tail_true = this.prev_true;
	this.tail_position = this.prev_position;

	return this.updateTrackPrev();
}

PlaneObject.prototype.updateTrackPrev = function() {

	this.prev_position = this.position;
	this.prev_time = this.position_time;
	this.prev_track = this.track;
	this.prev_true = this.true_head;

	return true;
}

// Appends data to the running track so we can get a visual tail on the plane
// Only useful for a long running browser session.
PlaneObject.prototype.updateTrack = function(receiver_timestamp, last_timestamp) {
	if (this.position == null)
		return false;
	if (this.prev_position && this.position[0] == this.prev_position[0] && this.position[1] == this.prev_position[1])
		return false;

	var projHere = ol.proj.fromLonLat(this.position);
	var on_ground = (this.altitude === "ground");

	if (this.track_linesegs.length == 0) {
		// Brand new track
		//console.log(this.icao + " new track");
		var newseg = { fixed: new ol.geom.LineString([projHere]),
			feature: null,
			estimated: false,
			ground: on_ground,
			altitude: this.altitude
		};
		this.track_linesegs.push(newseg);
		this.history_size ++;
		this.prev_position = this.position;
		return this.updateTail();
	}

	var projPrev = ol.proj.fromLonLat(this.prev_position);
	var lastseg = this.track_linesegs[this.track_linesegs.length - 1];
	var distance_traveled = ol.sphere.getDistance(this.tail_position, this.prev_position);

	// discard current position for track stuff while preventing the old position to go stale
	if (ol.sphere.getDistance(this.position, this.prev_position) < 8) {
		this.prev_time = this.position_time;
		return true;
	}
	if (this.dataSource == "mlat" && on_ground)
		return true;

	// Determine if track data are intermittent/stale
	// Time difference between two position updates should not be much
	// greater than the difference between data inputs
	var time_difference = (this.position_time - this.prev_time) - (receiver_timestamp - last_timestamp);

	var stale_timeout = 7;

	// MLAT data are given some more leeway
	if (this.dataSource == "mlat") stale_timeout = 15;

	// On the ground you can't go that quick
	if (on_ground) stale_timeout = 30;

	var est_track = (time_difference > stale_timeout);

	// Also check if the position was already stale when it was exported by dump1090
	// Makes stale check more accurate for example for 30s spaced history points

	est_track = est_track || ((receiver_timestamp - this.position_time) > stale_timeout);

	if (est_track) {

		if (!lastseg.estimated) {
			// >5s gap in data, create a new estimated segment
			//console.log(this.icao + " switching to estimated");
			lastseg.fixed.appendCoordinate(projPrev);
			this.track_linesegs.push({ fixed: new ol.geom.LineString([projPrev]),
				feature: null,
				altitude: 0,
				estimated: true });
			this.history_size += 2;
		} else {
			// Keep appending to the existing dashed line; keep every point
			lastseg.fixed.appendCoordinate(projPrev);
			this.history_size++;
		}

		return this.updateTail();
	}

	if (lastseg.estimated) {
		// We are back to good data (we got two points close in time), switch back to
		// solid lines.
		lastseg.fixed.appendCoordinate(projPrev);
		this.track_linesegs.push({ fixed: new ol.geom.LineString([projPrev]),
			feature: null,
			estimated: false,
			ground: on_ground,
			altitude: this.altitude });
		this.history_size += 2;

		return this.updateTail();
	}

	var track_change = this.track != null ? Math.abs(this.tail_track - this.track) : NaN;
	track_change = track_change < 180 ? track_change : Math.abs(track_change - 360);
	var true_change =  this.trueheading != null ? Math.abs(this.tail_true - this.true_heading) : NaN;
	true_change = true_change < 180 ? true_change : Math.abs(true_change - 360);
	if (!isNaN(true_change)) {
		track_change = isNaN(track_change) ? true_change : Math.max(track_change, true_change);
	}
	var alt_change = Math.abs(this.altitude - lastseg.altitude);
	var since_update = this.prev_time - this.tail_update;
	if (
		lastseg.ground != on_ground
		|| (!on_ground && isNaN(alt_change))
		|| (alt_change > 700)
		|| (alt_change > 375 && this.altitude < 9000)
		|| (alt_change > 150 && this.altitude < 5500)
	) {
		// Create a new segment as the ground state or the altitude changed.
		// The new state is only drawn after the state has changed
		// and we then get a new position.

		this.logSel("sec_elapsed: " + since_update.toFixed(1) + " alt_change: "+ alt_change.toFixed(0));

		// Let's assume the ground state change happened somewhere between the previous and current position
		// Represent that assumption. With altitude it's not quite as critical.
		if (lastseg.ground != on_ground) {
			projPrev = [(projPrev[0]+projHere[0])/2,(projPrev[1]+projHere[1])/2];
		}
		lastseg.fixed.appendCoordinate(projPrev);
		this.track_linesegs.push({ fixed: new ol.geom.LineString([projPrev]),
			feature: null,
			estimated: false,
			altitude: this.altitude,
			ground: on_ground });

		this.history_size += 2;

		return this.updateTail();
	}

	// Add current position to the existing track.
	// We only retain some points depending on time elapsed and track change
	var turn_density = 6.5;
	if (
		since_update > 42 ||
		(!on_ground && since_update > (100/turn_density)/track_change) ||
		(!on_ground && isNaN(track_change) && since_update > 8) ||
		(on_ground && since_update > (500/turn_density)/track_change && distance_traveled > 8) ||
		(on_ground && distance_traveled > 60 && since_update > 4) ||
		debugAll
	) {

		lastseg.fixed.appendCoordinate(projPrev);
		this.history_size ++;

		this.logSel("sec_elapsed: " + since_update.toFixed(1) + " " + (on_ground ? "ground" : "air") +  " dist:" + distance_traveled.toFixed(0) +  " track_change: "+ track_change.toFixed(1));

		return this.updateTail();
	}

	return this.updateTrackPrev();
};

// This is to remove the line from the screen if we deselect the plane
PlaneObject.prototype.clearLines = function() {
	if (this.layer.getVisible())
		this.layer.setVisible(false);
};

PlaneObject.prototype.getDataSourceNumber = function() {
	// MLAT
	if (this.dataSource == "mlat") {
		return 3;
	}
	if (this.dataSource == "uat")
		return 2; // UAT

	// Not MLAT, but position reported - ADSB or variants
	if (this.dataSource == "tisb")
		return 4; // TIS-B
	if (this.dataSource == "adsb")
		return 1;

	// Otherwise Mode S
	return 5;

	// TODO: add support for Mode A/C
};

PlaneObject.prototype.getDataSource = function() {
	// MLAT
	if (this.dataSource == "mlat") {
		return 'mlat';
	}
	if (this.dataSource == "uat")
		return 'uat';

	if (this.addrtype) {
		return this.addrtype;
	}

	if (this.dataSource == "adsb")
		return "adsb_icao";

	// Otherwise Mode S
	return 'mode_s';

	// TODO: add support for Mode A/C
};

PlaneObject.prototype.getMarkerColor = function() {
	// Emergency squawks override everything else
	if (this.squawk in SpecialSquawks)
		return SpecialSquawks[this.squawk].markerColor;

	var h, s, l;

	var colorArr = this.getAltitudeColor(this.altitude_cached);

	h = colorArr[0];
	s = colorArr[1];
	l = colorArr[2];

	// If we have not seen a recent position update, change color
	if (this.seen_pos > 15 && this.altitude !== "ground") {
		h += ColorByAlt.stale.h;
		s += ColorByAlt.stale.s;
		l += ColorByAlt.stale.l;
	}

	// If this marker is selected, change color
	if (this.selected && !SelectedAllPlanes){
		h += ColorByAlt.selected.h;
		s += ColorByAlt.selected.s;
		l += ColorByAlt.selected.l;
	}

	// If this marker is a mlat position, change color
	if (this.dataSource == "mlat") {
		h += ColorByAlt.mlat.h;
		s += ColorByAlt.mlat.s;
		l += ColorByAlt.mlat.l;
	}

	if (h < 0) {
		h = (h % 360) + 360;
	} else if (h >= 360) {
		h = h % 360;
	}

	if (s < 5) s = 5;
	else if (s > 95) s = 95;

	if (l < 5) l = 5;
	else if (l > 95) l = 95;

	return 'hsl(' + (h/5).toFixed(0)*5 + ',' + (s/5).toFixed(0)*5 + '%,' + (l/5).toFixed(0)*5 + '%)'
}

PlaneObject.prototype.getAltitudeColor = function(altitude) {
	var h, s, l;

	if (typeof altitude === 'undefined') {
		altitude = this.altitude;
	}

	if (altitude === null) {
		h = ColorByAlt.unknown.h;
		s = ColorByAlt.unknown.s;
		l = ColorByAlt.unknown.l;
	} else if (altitude === "ground") {
		h = ColorByAlt.ground.h;
		s = ColorByAlt.ground.s;
		l = ColorByAlt.ground.l;
	} else {
		s = ColorByAlt.air.s;
		l = ColorByAlt.air.l;

		// find the pair of points the current altitude lies between,
		// and interpolate the hue between those points
		var hpoints = ColorByAlt.air.h;
		h = hpoints[0].val;
		for (var i = hpoints.length-1; i >= 0; --i) {
			if (altitude > hpoints[i].alt) {
				if (i == hpoints.length-1) {
					h = hpoints[i].val;
				} else {
					h = hpoints[i].val + (hpoints[i+1].val - hpoints[i].val) * (altitude - hpoints[i].alt) / (hpoints[i+1].alt - hpoints[i].alt)
				}
				break;
			}
		}
	}

	if (h < 0) {
		h = (h % 360) + 360;
	} else if (h >= 360) {
		h = h % 360;
	}

	if (s < 5) s = 5;
	else if (s > 95) s = 95;

	if (l < 5) l = 5;
	else if (l > 95) l = 95;

	return [h, s, l];
}

PlaneObject.prototype.updateIcon = function() {

	var col = this.getMarkerColor();
	//var opacity = 1.0;
	var outline = (this.dataSource == "mlat" ? OutlineMlatColor : OutlineADSBColor);
	var add_stroke = (this.selected && !SelectedAllPlanes) ? ' stroke="black" stroke-width="1px"' : '';
	var baseMarkerKey = this.category + "!" + this.icaotype + "!" + this.typeDescription + "!" + this.wtc;
	if (this.baseMarkerKey != baseMarkerKey) {
		this.baseMarkerKey = baseMarkerKey;
		this.baseMarker = getBaseMarker(this.category, this.icaotype, this.typeDescription, this.wtc);
	}
	var rotation = this.track;
	if (rotation == null) {
		rotation = this.true_heading;
	} else if (rotation == null) {
		rotation = this.mag_heading;
	} else if (rotation == null) {
		rotation = 0;
	}

	//var transparentBorderWidth = (32 / this.baseMarker.scale / scaleFactor).toFixed(1);

	var svgKey = col + '!' + outline + '!' + this.baseMarker.svg + '!' + add_stroke;

	if (this.markerStyle == null || this.markerIcon == null || this.markerSvgKey != svgKey) {
		//console.log(this.icao + " new icon and style " + this.markerSvgKey + " -> " + svgKey);

		this.markerSvgKey = svgKey;

		var icon = new ol.style.Icon({
			anchor: [0.5, 0.5],
			anchorXUnits: 'fraction',
			anchorYUnits: 'fraction',
			scale: scaleFactor,
			imgSize: this.baseMarker.size,
			src: svgPathToURI(this.baseMarker.svg, outline, col, add_stroke),
			rotation: (this.baseMarker.noRotate ? 0 : rotation * Math.PI / 180.0),
			//opacity: opacity,
			rotateWithView: (this.baseMarker.noRotate ? false : true)
		});

		this.markerIcon = icon;
		this.markerStyle = new ol.style.Style({
			image: this.markerIcon
		});


		if (this.marker) {
			this.marker.setStyle(this.markerStyle);
		}
	}

	if (this.rotationCache == null || Math.abs(this.rotationCache - rotation) > 0.25) {
		this.rotationCache = rotation;
		this.markerIcon.setRotation(rotation * Math.PI / 180.0);
	}

	if (this.scaleFactorCache != scaleFactor) {
		this.scaleCache = scaleFactor;
		this.markerIcon.setScale(scaleFactor);
	}

	/*
	if (this.opacityCache != opacity) {
		this.opacityCache = opacity;
		this.markerIcon.setOpacity(opacity);
	}
	*/


	return true;
};

// Update our data
PlaneObject.prototype.updateData = function(receiver_timestamp, data, init) {
	// get location data first, return early if only those are needed.

	if ("lat" in data && data.seen_pos < (receiver_timestamp - this.position_time + 2)) {
		this.position   = [data.lon, data.lat];
		this.position_time = receiver_timestamp - data.seen_pos;
	}

	if (data.seen_pos < 45 && "mlat" in data && data.mlat.indexOf("lat") >= 0) {
		this.dataSource = "mlat";
	} else if (this.dataSource != "uat") {
		if (data.type && data.type.substring(0,4) == "tisb")
			this.dataSource = "tisb";
		else if (data.type == "adsb_icao" || data.type == "adsb_other")
			this.dataSource = "adsb";
		else if (data.type && data.type.substring(0,4) == "adsr")
			this.dataSource = "other";
		else if (data.type == "adsb_icao_nt")
			this.dataSource = "other";
		else if (this.position)
			this.dataSource = "adsb";
		else
			this.dataSource = "other";
	}

	if ("alt_baro" in data) {
		this.altitude = data.alt_baro;
		this.alt_baro = data.alt_baro;
	} else if ("altitude" in data) {
		this.altitude = data.altitude;
		this.alt_baro = data.altitude;
	}

	if ("track" in data)
		this.track = data.track;

	this.last_message_time = receiver_timestamp - data.seen;

	if (init)
		return;

	var alt_change = Math.abs(this.altitude - this.altitude_cached);
	if (isNaN(alt_change) || alt_change >= 75)
		this.altitude_cached = this.altitude;

	// Update all of our data
	this.messages	= data.messages;
	if (!this.rssa)
		this.rssa = [data.rssi,data.rssi,data.rssi,data.rssi];
	this.rssa[this.rindex++%4] = data.rssi;
	this.rssi       = (this.rssa[0] + this.rssa[1] + this.rssa[2] + this.rssa[3])/4;

	if ("gs" in data)
		this.gs = data.gs;
	else if ("speed" in data)
		this.gs = data.speed;

	if ("baro_rate" in data)
		this.baro_rate = data.baro_rate;
	else if ("vert_rate" in data)
		this.baro_rate = data.vert_rate;

	// simple fields

	this.alt_geom = data.alt_geom;
	this.speed = data.gs;
	this.ias = data.ias;
	this.tas = data.tas;
	this.track_rate = data.track_rate;
	this.mag_heading = data.mag_heading;
	this.mach = data.mach;
	this.roll = data.roll;
	this.nav_altitude = data.nav_altitude;
	this.nav_heading = data.nav_heading;
	this.nav_modes = data.nav_modes;
	this.nac_p = data.nac_p;
	this.nac_v = data.nac_v;
	this.nic_baro = data.nic_baro;
	this.sil_type = data.sil_type;
	this.sil = data.sil;
	this.nav_qnh = data.nav_qnh;
	this.geom_rate = data.geom_rate;
	this.rc = data.rc;
	this.squawk = data.squawk;
	this.category = data.category;
	this.version = data.version;

	// fields with more complex behaviour
	if ("true_heading" in data)
		this.true_heading = data.true_heading;

	// don't expire callsigns
	if ('flight' in data)
		this.flight	= data.flight;

	if ('type' in data)
		this.addrtype	= data.type;

	if ('lat' in data && SitePosition) {
		//var WGS84 = new ol.Sphere(6378137);
		//this.sitedist = WGS84.haversineDistance(SitePosition, this.position);
		this.sitedist = ol.sphere.getDistance(SitePosition, this.position);
	}

	// Pick a selected altitude
	if ('nav_altitude_fms' in data) {
		this.nav_altitude = data.nav_altitude_fms;
	} else if ('nav_altitude_mcp' in data) {
		this.nav_altitude = data.nav_altitude_mcp;
	} else {
		this.nav_altitude = null;
	}


	// Use geometric altitude if plane doesn't transmit alt_baro
	if (this.altitude == null && 'alt_geom' in data) {
		this.altitude = data.alt_geom;
	}

	// Pick vertical rate from either baro or geom rate
	// geometric rate is generally more reliable (smoothed etc)
	if ('geom_rate' in data) {
		this.vert_rate = data.geom_rate;
	} else if ('baro_rate' in data) {
		this.vert_rate = data.baro_rate;
	} else {
		this.vert_rate = null;
	}

};

PlaneObject.prototype.updateTick = function(receiver_timestamp, last_timestamp, init) {
	// recompute seen and seen_pos
	this.seen = receiver_timestamp - this.last_message_time;
	this.seen_pos = receiver_timestamp - this.position_time;

	// If no packet in over 58 seconds, clear the plane.
	// Only clear the plane if it's not selected individually
	if ((this.seen > 58 || this.position == null || this.seen_pos > 100)
		&& (!this.selected || SelectedAllPlanes)) {
		if (this.visible) {
			//console.log("hiding " + this.icao);
			this.clearMarker();
			this.clearLines();
			this.visible = false;
			if (SelectedPlane == this.icao)
				selectPlaneByHex(null,false);
		}
	} else {
		this.visible = true;
		if (init || this.updateTrack(receiver_timestamp, last_timestamp)) {
			this.updateLines();
			this.updateMarker(true);
		} else { 
			this.updateMarker(false); // didn't move
		}
	}
};

PlaneObject.prototype.clearMarker = function() {
	if (this.marker) {
		PlaneIconFeatures.remove(this.marker);
		/* FIXME google.maps.event.clearListeners(this.marker, 'click'); */
		this.marker = null;
	}
};

// Update our marker on the map
PlaneObject.prototype.updateMarker = function(moved) {
	if (!this.visible || this.position == null || this.isFiltered()) {
		this.clearMarker();
		return;
	}

	this.updateIcon();
	if (this.marker) {
		if (moved) {
			this.marker.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(this.position)));
		}
	} else {
		this.marker = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat(this.position)));
		this.marker.hex = this.icao;
		this.marker.setStyle(this.markerStyle);
		PlaneIconFeatures.push(this.marker);
	}
};


// return the styling of the lines based on altitude
PlaneObject.prototype.altitudeLines = function(altitude) {
	var colorArr = this.getAltitudeColor(altitude);
	var color = 'hsl(' + (colorArr[0]/5).toFixed(0)*5 + ',' + (colorArr[1]/5).toFixed(0)*5 + '%,' + (colorArr[2]/5).toFixed(0)*5 + '%)'
	if (!debug) {
		return new ol.style.Style({
			stroke: new ol.style.Stroke({
				color: color,
				width: 2,
			})
		});
	} else {
		return [
			new ol.style.Style({
				image: new ol.style.Circle({
					radius: 2,
					fill: new ol.style.Fill({
						color: color
					})
				}),
				geometry: function(feature) {
					return new ol.geom.MultiPoint(feature.getGeometry().getCoordinates());
				}
			}),
			new ol.style.Style({
				stroke: new ol.style.Stroke({
					color: color,
					width: 2
				})
			})
		];
	}
}

// Update our planes tail line,
PlaneObject.prototype.updateLines = function() {
	if (!this.selected)
		return;

	if (this.track_linesegs.length == 0)
		return;

	var estimateStyle = new ol.style.Style({
		stroke: new ol.style.Stroke({
			color: '#808080',
			width: 1.2
		})
	});

	var airStyle = new ol.style.Style({
		stroke: new ol.style.Stroke({
			color: '#000000',
			width: 2
		})
	});

	var groundStyle = new ol.style.Style({
		stroke: new ol.style.Stroke({
			color: '#408040',
			width: 2
		})
	});


	// create the new elastic band feature
	var lastseg = this.track_linesegs[this.track_linesegs.length - 1];
	var lastfixed = lastseg.fixed.getCoordinateAt(1.0);
	var geom = new ol.geom.LineString([lastfixed, ol.proj.fromLonLat(this.position)]);
	this.elastic_feature = new ol.Feature(geom);
	if (lastseg.estimated) {
		this.elastic_feature.setStyle(estimateStyle);
	} else {
		this.elastic_feature.setStyle(this.altitudeLines(lastseg.altitude));
	}

	// elastic feature is always at index 0 for each aircraft
	this.trail_features.setAt(0, this.elastic_feature);

	// create any missing fixed line features
	var start_i = 0;
	if (this.track_linesegs.length > 1 && this.track_linesegs[this.track_linesegs.length-2].feature != null)
		start_i = this.track_linesegs.length-1;

	for (var i = start_i; i < this.track_linesegs.length; ++i) {
		var seg = this.track_linesegs[i];
		if (!seg.feature) {
			seg.feature = new ol.Feature(seg.fixed);
			if (seg.estimated) {
				seg.feature.setStyle(estimateStyle);
			} else {
				seg.feature.setStyle(this.altitudeLines(seg.altitude));
			}

			this.trail_features.push(seg.feature);
		}
	}


	// after making sure everything is drawn, also show the layer
	if (!this.layer.getVisible())
		this.layer.setVisible(true);
};

PlaneObject.prototype.remakeTrail = function() {

	this.trail_features.clear();
	for (var i in this.track_linesegs) {
		this.track_linesegs[i].feature = null;
	}
	this.elastic_feature = null;

	trailGroup.remove(this.layer);

	this.trail_features = new ol.Collection();

	this.layer = new ol.layer.Vector({
		name: this.icao,
		source: new ol.source.Vector({
			features: this.trail_features,
		})
	});

	trailGroup.push(this.layer);

	this.updateLines();
}

PlaneObject.prototype.destroy = function() {
	this.clearLines();
	this.clearMarker();
	trailGroup.remove(this.layer);
	this.trail_features.clear();
	if (this.tr) {
		this.tr.removeEventListener('click', this.clickListener);
		this.tr.removeEventListener('dblclick', this.dblclickListener);
		if (this.tr.parentNode)
			this.tr.parentNode.removeChild(this.tr);
		this.tr = null;
	}
	this.track_linesegs = null;
	this.filter = null;
	this.markerIcon = null;
	this.markerStyle = null;
	if (this.icao == SelectedPlane)
		SelectedPlane = null;
};
