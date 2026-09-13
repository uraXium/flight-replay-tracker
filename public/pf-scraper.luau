--[[
    Project Flight -> your own radar
    Run this in Roblox (executor / spectator client) while you are in a Project Flight server.
    It scans workspace for aircraft every second and posts telemetry to your app.

    1. Paste the ingest token you saved in the app below.
    2. Run. Your map will switch to "own-scraper" within a few seconds.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local INGEST_URL = "https://project--228eed25-363a-4814-b40a-4d1c1ac3c51e-dev.lovable.app/api/public/ingest"
local INGEST_TOKEN = "PASTE_YOUR_TOKEN_HERE"
local REFRESH_RATE = 1.0

local STUDS_TO_FEET = 0.92
local STUDS_SEC_TO_KNOTS = 0.544
local COORD_SCALE = 1000.0

local function getRootPart(model)
    return model.PrimaryPart
        or model:FindFirstChild("HumanoidRootPart")
        or model:FindFirstChild("Main")
        or model:FindFirstChild("Engine")
        or model:FindFirstChildWhichIsA("BasePart")
end

local function getCallsign(model)
    if model:GetAttribute("Callsign") then return tostring(model:GetAttribute("Callsign")) end
    if model:GetAttribute("FlightNumber") then return tostring(model:GetAttribute("FlightNumber")) end

    for _, desc in ipairs(model:GetDescendants()) do
        if desc:IsA("TextLabel") and desc.Text and #desc.Text >= 3 then
            local clean = desc.Text:gsub("%s+", "")
            if clean:match("^%a%a%a?%d+") then return clean end
        end
    end

    local seat = model:FindFirstChildWhichIsA("VehicleSeat") or model:FindFirstChild("Seat")
    if seat and seat.Occupant and seat.Occupant.Parent then
        local player = Players:GetPlayerFromCharacter(seat.Occupant.Parent)
        if player then return player.Name:upper() end
    end

    return model.Name:upper():sub(1, 10)
end

local function getPilot(model)
    local seat = model:FindFirstChildWhichIsA("VehicleSeat") or model:FindFirstChild("Seat")
    if seat and seat.Occupant and seat.Occupant.Parent then
        local player = Players:GetPlayerFromCharacter(seat.Occupant.Parent)
        if player then return player.Name end
    end
    return ""
end

local function scanTraffic()
    local list = {}
    for _, item in ipairs(workspace:GetChildren()) do
        if item:IsA("Model") then
            local hasSeat = item:FindFirstChildWhichIsA("VehicleSeat")
                or item:FindFirstChild("PilotSeat")
                or item:FindFirstChild("Seat")
            if hasSeat then
                local root = getRootPart(item)
                if root then
                    local pos = root.Position
                    local vel = root.AssemblyLinearVelocity
                    local orient = root.Orientation
                    table.insert(list, {
                        id = tostring(item:GetAttribute("FlightId") or (item.Name .. "_" .. tostring(math.floor(pos.X)))),
                        callsign = getCallsign(item),
                        squawk = tostring(item:GetAttribute("Squawk") or "1200"),
                        x = math.floor(pos.X / COORD_SCALE * 100) / 100,
                        y = math.floor(pos.Z / COORD_SCALE * 100) / 100,
                        altitude = math.max(0, math.floor(pos.Y * STUDS_TO_FEET)),
                        heading = math.floor((orient.Y + 360) % 360),
                        speed = math.floor(vel.Magnitude * STUDS_SEC_TO_KNOTS),
                        aircraft_type = item.Name,
                        player = getPilot(item),
                    })
                end
            end
        end
    end
    return list
end

local sendRequest = (syn and syn.request)
    or (http and http.request)
    or http_request
    or request
    or (function(opts)
        return pcall(function()
            return HttpService:RequestAsync({
                Url = opts.Url,
                Method = opts.Method or "POST",
                Headers = opts.Headers or { ["Content-Type"] = "application/json" },
                Body = opts.Body,
            })
        end)
    end)

print("[Project Flight] scraper active -> " .. INGEST_URL)

task.spawn(function()
    while true do
        local planes = scanTraffic()
        if #planes > 0 then
            local payload = {
                source = "roblox_client",
                server_job_id = game.JobId or "standalone",
                timestamp = os.time(),
                aircraft = planes,
            }
            pcall(function()
                sendRequest({
                    Url = INGEST_URL,
                    Method = "POST",
                    Headers = {
                        ["Content-Type"] = "application/json",
                        ["x-ingest-token"] = INGEST_TOKEN,
                    },
                    Body = HttpService:JSONEncode(payload),
                })
            end)
        end
        task.wait(REFRESH_RATE)
    end
end)
