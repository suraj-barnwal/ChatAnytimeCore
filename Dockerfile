FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY OnChat_CoreAPI/ChatAPI.csproj ./
RUN dotnet restore ChatAPI.csproj
COPY OnChat_CoreAPI/ ./
RUN dotnet publish ChatAPI.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "ChatAPI.dll"]
